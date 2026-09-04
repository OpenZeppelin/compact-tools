import { describe, expect, it, vi } from 'vitest';
import { derivePrivateStatePassword } from './private-state-password.ts';

describe('derivePrivateStatePassword', () => {
  it('should be deterministic for the same input', () => {
    const a = derivePrivateStatePassword('abcdef1234567890');
    const b = derivePrivateStatePassword('abcdef1234567890');
    expect(a).toBe(b);
  });

  it('should differ for different inputs', () => {
    const a = derivePrivateStatePassword('abcdef1234567890');
    const b = derivePrivateStatePassword('abcdef1234567891');
    expect(a).not.toBe(b);
  });

  it('should not contain 4 identical chars in a row', () => {
    for (let i = 0; i < 200; i++) {
      const pw = derivePrivateStatePassword(`pubkey-${i}`);
      expect(pw).not.toMatch(/(.)\1{3,}/);
    }
  });

  it('should produce a password with mixed character classes (uppercase + digit + symbol)', () => {
    const pw = derivePrivateStatePassword('any input');
    expect(pw).toMatch(/[A-Z]/);
    expect(pw).toMatch(/[0-9]/);
    expect(pw).toMatch(/[^A-Za-z0-9]/);
  });

  it('should handle inputs that would have produced naïve-bad passwords', () => {
    // A 64-zero hex (the kind of structured pubkey that breaks
    // `${encKey}A!`-style derivations) must still produce a valid password.
    const pw = derivePrivateStatePassword('0'.repeat(64));
    expect(pw).not.toMatch(/(.)\1{3,}/);
  });

  it('should throw after 1024 rounds when every hash has 4+ identical chars', async () => {
    // Force every round to produce a string that hits the `(.)\1{3,}` guard so
    // the loop exhausts its retry budget and reaches the explicit throw.
    vi.resetModules();
    vi.doMock('node:crypto', async () => {
      const actual =
        await vi.importActual<typeof import('node:crypto')>('node:crypto');
      return {
        ...actual,
        createHash: () => ({
          update: () => ({
            digest: () => 'aaaaBBBBccccDDDD',
          }),
        }),
      };
    });
    const { derivePrivateStatePassword: derive } = await import(
      './private-state-password.ts'
    );
    expect(() => derive('anything')).toThrow(/unable to find a hash/);
    vi.doUnmock('node:crypto');
    vi.resetModules();
  });
});
