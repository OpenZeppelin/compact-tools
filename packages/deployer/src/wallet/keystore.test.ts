import { describe, expect, it } from 'vitest';
import { WalletError } from '../errors.ts';
import { Keystore, type MidnightKeystore } from './keystore.ts';

const FAST_OPTS = { scryptN: 1024, scryptR: 8, scryptP: 1, dklen: 32 };
const SEED = 'deadbeef'.repeat(8);

describe('Keystore', () => {
  it('should round-trip a seed through encrypt → decrypt', () => {
    const ks = Keystore.encrypt(SEED, 'hunter2', FAST_OPTS);
    const json = ks.toJSON();
    expect(json.version).toBe('midnight-1');
    expect(json.crypto.cipher).toBe('aes-128-ctr');
    expect(json.crypto.kdf).toBe('scrypt');
    expect(ks.decrypt('hunter2')).toBe(SEED);
  });

  it('should reject a wrong passphrase with MAC mismatch', () => {
    const ks = Keystore.encrypt(SEED, 'hunter2', FAST_OPTS);
    expect(() => ks.decrypt('wrong')).toThrow(/MAC mismatch/);
  });

  it('should reject an unsupported version at fromJSON', () => {
    const ks = Keystore.encrypt(SEED, 'hunter2', FAST_OPTS);
    const tampered = {
      ...ks.toJSON(),
      version: 'eth-3',
    } as unknown as MidnightKeystore;
    expect(() => Keystore.fromJSON(tampered)).toThrow(WalletError);
  });

  it('should produce a different ciphertext on each encryption (random salt/iv)', () => {
    const a = Keystore.encrypt(SEED, 'pp', FAST_OPTS).toJSON();
    const b = Keystore.encrypt(SEED, 'pp', FAST_OPTS).toJSON();
    expect(a.crypto.ciphertext).not.toBe(b.crypto.ciphertext);
    expect(a.crypto.kdfparams.salt).not.toBe(b.crypto.kdfparams.salt);
  });
});
