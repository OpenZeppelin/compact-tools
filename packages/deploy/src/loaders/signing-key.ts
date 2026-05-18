import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { ConfigError } from '../errors.ts';

/**
 * Read a 32-byte signing key from `[contracts.X].signing_key_file` and
 * return it as lowercase hex (no `0x` prefix).
 *
 * The signing key is the contract's maintenance authority. We refuse fuzzy
 * input formats — exactly 64 hex chars after stripping optional `0x` and
 * trimming whitespace — to avoid the foot-gun where midnight-js silently
 * auto-samples a key the user then can't recover.
 */
export async function loadSigningKey(
  rootDir: string,
  path: string,
): Promise<string> {
  const abs = isAbsolute(path) ? path : resolve(rootDir, path);
  let raw: string;
  try {
    raw = await readFile(abs, 'utf8');
  } catch (e) {
    throw new ConfigError(
      `signing_key_file: failed to read ${abs}: ${(e as Error).message}`,
    );
  }
  const trimmed = raw.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new ConfigError(
      `signing_key_file ${abs}: expected 32 bytes hex-encoded (64 hex chars)`,
    );
  }
  return trimmed.toLowerCase();
}
