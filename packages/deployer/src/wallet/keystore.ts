/**
 * Web3 Secret Storage v3-shaped JSON keystore (scrypt + AES-128-CTR +
 * SHA-256 MAC) with a `version: "midnight-1"` marker so future schema
 * bumps don't collide with Ethereum tooling that reads v3.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { WalletError } from '../errors.ts';

const VERSION = 'midnight-1';

/** On-disk JSON shape. Exported so consumers can transport keystores verbatim. */
export interface MidnightKeystore {
  version: typeof VERSION;
  id: string;
  crypto: {
    cipher: 'aes-128-ctr';
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: 'scrypt';
    kdfparams: { dklen: number; n: number; p: number; r: number; salt: string };
    mac: string;
  };
}

export interface KeystoreCreateOptions {
  scryptN?: number;
  scryptP?: number;
  scryptR?: number;
  dklen?: number;
}

const DEFAULTS: Required<KeystoreCreateOptions> = {
  scryptN: 1 << 17,
  scryptP: 1,
  scryptR: 8,
  dklen: 32,
};

/** `maxmem` handed to every `scryptSync` call, and the budget params are held to. */
const SCRYPT_MAX_MEM_BYTES = 512 * 1024 * 1024;

const asMiB = (bytes: number) => Math.round(bytes / (1024 * 1024));

/**
 * Describe why `scryptSync` would refuse these params, or `undefined` when it
 * accepts them. Peak allocation is OpenSSL's `Blen + Vlen`, and `n` is capped
 * at `2 ** (16 * r)` however little memory that needs. Without this, a
 * hostile or hand-edited keystore surfaces as a raw OpenSSL `RangeError`
 * instead of a {@link WalletError}.
 */
function scryptParamsFault(params: {
  n: number;
  p: number;
  r: number;
}): string | undefined {
  const { n, p, r } = params;
  const bytes = 128 * r * (n + p + 2);
  if (bytes > SCRYPT_MAX_MEM_BYTES) {
    return `n=${n} r=${r} p=${p} needs ${asMiB(bytes)} MiB, over the ${asMiB(SCRYPT_MAX_MEM_BYTES)} MiB scrypt memory limit`;
  }
  if (n >= 2 ** (16 * r)) {
    return `n=${n} is at or above scrypt's ceiling of 2 ** (16 * r) for r=${r}`;
  }
  return undefined;
}

const hex = (bytes?: number) =>
  z
    .string()
    .refine(
      (s) =>
        /^[0-9a-fA-F]*$/.test(s) &&
        s.length % 2 === 0 &&
        (bytes === undefined || s.length === bytes * 2),
      bytes === undefined
        ? 'expected a hex string'
        : `expected ${bytes * 2} hex chars`,
    );

/**
 * Full on-disk shape, and the only validation `fromJSON` performs. The scrypt
 * bounds cap the work a hostile keystore can force on anyone who opens the
 * file, and {@link scryptParamsFault} rejects the combinations `scryptSync`
 * itself refuses. `dklen` is fixed at 32 because {@link Keystore.decrypt}
 * splits it 16/16 into the AES key and the MAC key.
 */
const keystoreSchema = z.object({
  version: z.literal(VERSION),
  id: z.string().min(1),
  crypto: z.object({
    cipher: z.literal('aes-128-ctr'),
    ciphertext: hex(),
    cipherparams: z.object({ iv: hex(16) }),
    kdf: z.literal('scrypt'),
    kdfparams: z
      .object({
        dklen: z.literal(32),
        n: z
          .number()
          .int()
          .min(1024)
          .max(2 ** 20)
          .refine((v) => (v & (v - 1)) === 0, 'expected a power of two'),
        p: z.number().int().min(1).max(16),
        r: z.number().int().min(1).max(32),
        salt: hex(),
      })
      .superRefine((params, ctx) => {
        const fault = scryptParamsFault(params);
        if (fault) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: fault });
        }
      }),
    mac: hex(32),
  }),
});

/** Encrypted wallet-seed wrapper; invariants enforced at construction. */
export class Keystore {
  readonly #data: MidnightKeystore;

  private constructor(data: MidnightKeystore) {
    this.#data = data;
  }

  /** Encrypt a 32-byte hex seed (with or without `0x`) under `passphrase`. Override {@link DEFAULTS} only for tests that need fast scrypt. */
  static encrypt(
    seedHex: string,
    passphrase: string,
    opts: KeystoreCreateOptions = {},
  ): Keystore {
    const seed = seedFromHex(seedHex);
    const { scryptN, scryptP, scryptR, dklen } = { ...DEFAULTS, ...opts };
    // `decrypt` splits the derived key 16/16 and the schema pins `dklen` to
    // 32, so any other length writes a keystore that can never be read back.
    if (dklen !== 32) {
      throw new WalletError(`Keystore dklen must be 32, got ${dklen}`);
    }
    const fault = scryptParamsFault({ n: scryptN, p: scryptP, r: scryptR });
    if (fault) {
      throw new WalletError(`Unusable keystore scrypt params: ${fault}`);
    }

    const salt = randomBytes(32);
    const iv = randomBytes(16);
    const derived = scryptSync(Buffer.from(passphrase, 'utf8'), salt, dklen, {
      N: scryptN,
      p: scryptP,
      r: scryptR,
      maxmem: SCRYPT_MAX_MEM_BYTES,
    });

    const encKey = derived.subarray(0, 16);
    const macKey = derived.subarray(16, 32);

    const cipher = createCipheriv('aes-128-ctr', encKey, iv);
    const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
    const mac = createHash('sha256')
      .update(Buffer.concat([macKey, ciphertext]))
      .digest();

    return new Keystore({
      version: VERSION,
      id: randomUUID(),
      crypto: {
        cipher: 'aes-128-ctr',
        ciphertext: ciphertext.toString('hex'),
        cipherparams: { iv: iv.toString('hex') },
        kdf: 'scrypt',
        kdfparams: {
          dklen,
          n: scryptN,
          p: scryptP,
          r: scryptR,
          salt: salt.toString('hex'),
        },
        mac: mac.toString('hex'),
      },
    });
  }

  /** Read + parse a JSON keystore file. Validates via {@link Keystore.fromJSON}. */
  static async readFromFile(path: string): Promise<Keystore> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (e) {
      throw new WalletError(
        `Failed to read keystore at ${path}: ${(e as Error).message}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new WalletError(
        `Invalid JSON in keystore ${path}: ${(e as Error).message}`,
      );
    }
    return Keystore.fromJSON(parsed);
  }

  /**
   * Wrap parsed keystore JSON. Validates the complete shape, so `decrypt`
   * can index into `crypto` without guards and never surfaces a raw
   * `TypeError` from a hand-edited or truncated file.
   */
  static fromJSON(data: unknown): Keystore {
    const parsed = keystoreSchema.safeParse(data);
    if (!parsed.success) {
      throw new WalletError(
        `Invalid keystore: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return new Keystore(parsed.data);
  }

  /** Recover the hex-encoded seed. Throws {@link WalletError} on MAC mismatch. */
  decrypt(passphrase: string): string {
    const { kdfparams, ciphertext, cipherparams, mac } = this.#data.crypto;
    const derived = scryptSync(
      Buffer.from(passphrase, 'utf8'),
      Buffer.from(kdfparams.salt, 'hex'),
      kdfparams.dklen,
      {
        N: kdfparams.n,
        p: kdfparams.p,
        r: kdfparams.r,
        maxmem: SCRYPT_MAX_MEM_BYTES,
      },
    );
    const encKey = derived.subarray(0, 16);
    const macKey = derived.subarray(16, 32);

    const cipherBytes = Buffer.from(ciphertext, 'hex');
    const expectedMac = createHash('sha256')
      .update(Buffer.concat([macKey, cipherBytes]))
      .digest();
    // Constant-time: a length-dependent early exit would leak how much of a
    // guessed passphrase's MAC matched. Lengths are equal by construction,
    // `mac` being pinned to 32 bytes by the schema.
    if (!timingSafeEqual(expectedMac, Buffer.from(mac, 'hex'))) {
      throw new WalletError(
        'Keystore MAC mismatch (wrong passphrase or corrupted file)',
      );
    }

    const decipher = createDecipheriv(
      'aes-128-ctr',
      encKey,
      Buffer.from(cipherparams.iv, 'hex'),
    );
    const plain = Buffer.concat([
      decipher.update(cipherBytes),
      decipher.final(),
    ]);
    return plain.toString('hex');
  }

  /** Write to disk as pretty JSON with mode `0o600`. */
  async writeToFile(path: string): Promise<void> {
    await writeFile(path, `${JSON.stringify(this.#data, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  /** Return the on-disk JSON shape. */
  toJSON(): MidnightKeystore {
    return this.#data;
  }
}

function seedFromHex(hex: string): Buffer {
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(stripped) || stripped.length % 2 !== 0) {
    throw new WalletError('Seed must be hex-encoded');
  }
  return Buffer.from(stripped, 'hex');
}
