import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WalletError } from '../errors.ts';
import { Keystore, type MidnightKeystore } from './keystore.ts';

const FAST_OPTS = { scryptN: 1024, scryptR: 8, scryptP: 1, dklen: 32 };
const SEED = 'deadbeef'.repeat(8);

describe('Keystore', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'keystore-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('encrypt / decrypt', () => {
    it('should round-trip a seed through encrypt → decrypt', () => {
      const ks = Keystore.encrypt(SEED, 'hunter2', FAST_OPTS);
      const json = ks.toJSON();
      expect(json.version).toBe('midnight-1');
      expect(json.crypto.cipher).toBe('aes-128-ctr');
      expect(json.crypto.kdf).toBe('scrypt');
      expect(ks.decrypt('hunter2')).toBe(SEED);
    });

    it('should accept a 0x-prefixed hex seed and round-trip back to unprefixed hex', () => {
      const ks = Keystore.encrypt(`0x${SEED}`, 'pw', FAST_OPTS);
      expect(ks.decrypt('pw')).toBe(SEED);
    });

    it('should reject a non-hex seed', () => {
      expect(() => Keystore.encrypt('not hex!', 'pw', FAST_OPTS)).toThrow(
        WalletError,
      );
    });

    it('should reject an odd-length hex seed', () => {
      expect(() => Keystore.encrypt('abc', 'pw', FAST_OPTS)).toThrow(
        WalletError,
      );
    });

    it('should reject a wrong passphrase with MAC mismatch', () => {
      const ks = Keystore.encrypt(SEED, 'hunter2', FAST_OPTS);
      expect(() => ks.decrypt('wrong')).toThrow(/MAC mismatch/);
    });

    it('should produce a different ciphertext on each encryption (random salt/iv)', () => {
      const a = Keystore.encrypt(SEED, 'pp', FAST_OPTS).toJSON();
      const b = Keystore.encrypt(SEED, 'pp', FAST_OPTS).toJSON();
      expect(a.crypto.ciphertext).not.toBe(b.crypto.ciphertext);
      expect(a.crypto.kdfparams.salt).not.toBe(b.crypto.kdfparams.salt);
    });
  });

  describe('toJSON', () => {
    it('should expose the full on-disk shape with all crypto fields', () => {
      const ks = Keystore.encrypt(SEED, 'pw', FAST_OPTS);
      const json = ks.toJSON();
      expect(json.version).toBe('midnight-1');
      expect(typeof json.id).toBe('string');
      expect(json.crypto.cipher).toBe('aes-128-ctr');
      expect(json.crypto.kdf).toBe('scrypt');
      expect(typeof json.crypto.ciphertext).toBe('string');
      expect(typeof json.crypto.mac).toBe('string');
      expect(typeof json.crypto.cipherparams.iv).toBe('string');
      expect(json.crypto.kdfparams).toMatchObject({
        dklen: 32,
        n: 1024,
        p: 1,
        r: 8,
      });
      expect(typeof json.crypto.kdfparams.salt).toBe('string');
    });
  });

  describe('writeToFile', () => {
    it('should write JSON to disk with mode 0o600', async () => {
      const ks = Keystore.encrypt(SEED, 'pw', FAST_OPTS);
      const path = join(tmp, 'wallet.json');
      await ks.writeToFile(path);
      const st = statSync(path);
      // mask out file-type bits, only check perm bits
      expect(st.mode & 0o777).toBe(0o600);
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      expect(parsed.version).toBe('midnight-1');
    });
  });

  describe('readFromFile', () => {
    it('should round-trip through writeToFile + readFromFile + decrypt', async () => {
      const ks = Keystore.encrypt(SEED, 'pw', FAST_OPTS);
      const path = join(tmp, 'wallet.json');
      await ks.writeToFile(path);
      const loaded = await Keystore.readFromFile(path);
      expect(loaded.decrypt('pw')).toBe(SEED);
    });

    it('should wrap fs errors as WalletError', async () => {
      await expect(
        Keystore.readFromFile(join(tmp, 'does-not-exist.json')),
      ).rejects.toThrow(/Failed to read keystore at/);
    });

    it('should reject invalid JSON with WalletError', async () => {
      const path = join(tmp, 'bad.json');
      await writeFile(path, '{ not valid json');
      await expect(Keystore.readFromFile(path)).rejects.toThrow(
        /Invalid JSON in keystore/,
      );
    });
  });

  describe('fromJSON validation', () => {
    it('should reject an unsupported version', () => {
      const ks = Keystore.encrypt(SEED, 'pw', FAST_OPTS);
      const tampered = {
        ...ks.toJSON(),
        version: 'eth-3',
      } as unknown as MidnightKeystore;
      expect(() => Keystore.fromJSON(tampered)).toThrow(
        /Unsupported keystore version/,
      );
    });

    it('should reject an unsupported KDF', () => {
      const ks = Keystore.encrypt(SEED, 'pw', FAST_OPTS).toJSON();
      const tampered = {
        ...ks,
        crypto: { ...ks.crypto, kdf: 'pbkdf2' },
      } as unknown as MidnightKeystore;
      expect(() => Keystore.fromJSON(tampered)).toThrow(/Unsupported KDF/);
    });

    it('should reject an unsupported cipher', () => {
      const ks = Keystore.encrypt(SEED, 'pw', FAST_OPTS).toJSON();
      const tampered = {
        ...ks,
        crypto: { ...ks.crypto, cipher: 'aes-256-gcm' },
      } as unknown as MidnightKeystore;
      expect(() => Keystore.fromJSON(tampered)).toThrow(/Unsupported cipher/);
    });

    it('should reject a non-object with WalletError (not a raw TypeError)', () => {
      expect(() => Keystore.fromJSON(null)).toThrow(WalletError);
      expect(() => Keystore.fromJSON('nope')).toThrow(/expected an object/);
    });

    it('should reject JSON missing the crypto section with WalletError', () => {
      expect(() => Keystore.fromJSON({ version: 'midnight-1' })).toThrow(
        /missing crypto section/,
      );
    });
  });
});
