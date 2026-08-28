import { createHash } from 'node:crypto';

/**
 * Derive a leveldb-compatible password from secret key material. `secret`
 * must be secret-derived (the deployer passes SHA-256 of the wallet seed);
 * a public key would make the private-state DB decryptable by anyone who
 * can read the wallet's address.
 *
 * level-private-state-provider rejects passwords with 4+ identical chars in
 * a row, which structured seeds (TEST_MNEMONIC, `0x…0001`) routinely
 * produce. We SHA-256 + base64url + strip + rehash-on-collision until clean,
 * then append `A1!` for guaranteed character-class diversity.
 */
export function derivePrivateStatePassword(secret: string): string {
  for (let counter = 0; counter < 1024; counter++) {
    const body = createHash('sha256')
      .update(`${secret}:${counter}`)
      .digest('base64url')
      .replace(/[^A-Za-z0-9]/g, '');
    if (!/(.)\1{3,}/.test(body)) {
      return `${body}A1!`;
    }
  }
  // Pathologically improbable. Surface explicitly so the deploy fails loud
  // rather than silently retrying forever.
  throw new Error(
    'derivePrivateStatePassword: unable to find a hash without 4+ repeated chars after 1024 rounds',
  );
}
