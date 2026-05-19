/**
 * JSON keystore for a 32-byte wallet seed.
 *
 * Crypto matches Ethereum Web3 Secret Storage v3 conventions
 * (scrypt-derived key + AES-128-CTR + SHA-256 MAC over `macKey ‖ ciphertext`),
 * with a `version: "midnight-1"` marker so we can migrate the on-disk
 * shape later without colliding with Ethereum tooling that reads v3.
 *
 * Defaults: scrypt N=2^17, r=8, p=1, dklen=32 — same as Foundry's `cast wallet`.
 * Files are written with mode `0600`.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { WalletError } from '../errors.ts';

const VERSION = 'midnight-1';

/** On-disk JSON shape — exported so consumers can transport/serialize keystores verbatim. */
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

/**
 * Encrypted wallet-seed wrapper.
 *
 * Always acquired via a named constructor — {@link Keystore.encrypt} to wrap
 * a fresh seed, {@link Keystore.readFromFile} or {@link Keystore.fromJSON}
 * to adopt an existing one. The version + cipher + KDF invariants are
 * enforced at construction so the rest of the package never sees an invalid
 * keystore.
 */
export class Keystore {
  readonly #data: MidnightKeystore;

  private constructor(data: MidnightKeystore) {
    this.#data = data;
  }

  /**
   * Encrypt a 32-byte hex seed (with or without `0x` prefix) under
   * `passphrase`. Uses {@link DEFAULTS} unless overridden — override only
   * for tests that need fast scrypt.
   */
  static encrypt(
    seedHex: string,
    passphrase: string,
    opts: KeystoreCreateOptions = {},
  ): Keystore {
    const seed = seedFromHex(seedHex);
    const { scryptN, scryptP, scryptR, dklen } = { ...DEFAULTS, ...opts };

    const salt = randomBytes(32);
    const iv = randomBytes(16);
    const derived = scryptSync(Buffer.from(passphrase, 'utf8'), salt, dklen, {
      N: scryptN,
      p: scryptP,
      r: scryptR,
      maxmem: 512 * 1024 * 1024,
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

  /**
   * Read + parse a JSON keystore file. Validates version/cipher/KDF before
   * returning — see {@link Keystore.fromJSON}.
   */
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
    return Keystore.fromJSON(parsed as MidnightKeystore);
  }

  /**
   * Wrap an already-parsed keystore JSON object. Validates version,
   * cipher, and KDF eagerly — invalid keystores throw before any
   * decrypt attempt.
   */
  static fromJSON(data: MidnightKeystore): Keystore {
    if (data.version !== VERSION) {
      throw new WalletError(
        `Unsupported keystore version: ${data.version} (expected ${VERSION})`,
      );
    }
    if (data.crypto.kdf !== 'scrypt') {
      throw new WalletError(
        `Unsupported KDF: ${data.crypto.kdf} (expected scrypt)`,
      );
    }
    if (data.crypto.cipher !== 'aes-128-ctr') {
      throw new WalletError(
        `Unsupported cipher: ${data.crypto.cipher} (expected aes-128-ctr)`,
      );
    }
    return new Keystore(data);
  }

  /**
   * Recover the hex-encoded seed. Throws {@link WalletError} on MAC
   * mismatch (wrong passphrase or corrupted file).
   */
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
        maxmem: 512 * 1024 * 1024,
      },
    );
    const encKey = derived.subarray(0, 16);
    const macKey = derived.subarray(16, 32);

    const cipherBytes = Buffer.from(ciphertext, 'hex');
    const expectedMac = createHash('sha256')
      .update(Buffer.concat([macKey, cipherBytes]))
      .digest('hex');
    if (expectedMac !== mac) {
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

  /** Return the on-disk JSON shape (e.g. to embed in a multi-keystore file). */
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
