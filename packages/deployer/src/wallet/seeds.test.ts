import { describe, expect, it } from 'vitest';
import { WalletError } from '../errors.ts';
import { classifySeed } from './seeds.ts';

describe('classifySeed', () => {
  it('classifies a 64-char hex string as hex (lowercased)', () => {
    const hex = 'A'.repeat(64);
    expect(classifySeed(hex)).toEqual({ kind: 'hex', value: 'a'.repeat(64) });
  });

  it('classifies a 128-char hex string as hex', () => {
    const hex = `${'0'.repeat(127)}1`;
    expect(classifySeed(hex)).toEqual({ kind: 'hex', value: hex });
  });

  it('classifies a valid BIP39 mnemonic as mnemonic (no conversion)', () => {
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    expect(classifySeed(mnemonic)).toEqual({ kind: 'mnemonic', value: mnemonic });
  });

  it('rejects empty input', () => {
    expect(() => classifySeed('   ')).toThrow(WalletError);
  });

  it('rejects an invalid hex length', () => {
    expect(() => classifySeed('abc123')).toThrow(WalletError);
  });

  it('rejects gibberish that is neither hex nor BIP39', () => {
    expect(() => classifySeed('this is definitely not valid')).toThrow(
      WalletError,
    );
  });
});
