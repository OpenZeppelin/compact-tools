import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DeploymentsFileError } from '../errors.ts';

/**
 * Parse `path`, or return `fallback` when it is absent or blank. A malformed
 * document is a typed failure naming the file: the raw `SyntaxError` says only
 * "Unexpected token" and leaves the user hunting for which file to fix.
 */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  const raw = await readFile(path, 'utf8');
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new DeploymentsFileError(
      `${path} is not valid JSON: ${(e as Error).message}. Repair or delete the file, then re-run.`,
      { cause: e },
    );
  }
}

// Write atomically: a crash mid-write would otherwise leave a truncated
// `*.json`, breaking subsequent reads and losing durable deploy state.
// Write to a sibling temp file, then rename it into place (atomic on the
// same filesystem).
export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}
