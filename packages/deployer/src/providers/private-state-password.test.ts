import { describe, expect, it } from 'vitest';
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
});
