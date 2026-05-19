import { createHash } from 'node:crypto';

/**
 * Derive a private-state-store password from a wallet's encryption public
 * key.
 *
 * The level-private-state-provider validates the password (no 4+ identical
 * chars in a row, mixed character classes). Naïve interpolations like
 * `${encryptionPublicKey}A!` fail when the hex public key happens to
 * contain runs of identical hex digits — which it routinely does for
 * structured seeds like `TEST_MNEMONIC` or `0x…0001`.
 *
 * Strategy: SHA-256 the key, base64url-encode, strip non-alphanumerics,
 * and append a fixed `A1!` suffix for guaranteed character-class diversity.
 * If the digest happens to contain a 4-in-a-row run (≈0.01% per draw), we
 * deterministically rehash with an incrementing counter until clean. Same
 * input always produces the same output, so the local leveldb stays
 * decryptable across runs.
 */
export function derivePrivateStatePassword(
  encryptionPublicKey: string,
): string {
  for (let counter = 0; counter < 1024; counter++) {
    const body = createHash('sha256')
      .update(`${encryptionPublicKey}:${counter}`)
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
