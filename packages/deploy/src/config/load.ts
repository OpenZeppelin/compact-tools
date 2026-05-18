import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ConfigError } from '../errors.ts';
import { type CompactConfig, configSchema } from './schema.ts';

/**
 * Find, parse, and validate `compact.toml` against {@link configSchema}.
 *
 * When `explicitPath` is omitted the loader walks the directory tree
 * upward from `cwd` (Foundry-style) and the *first* `compact.toml` found
 * becomes the project root. `rootDir` in the returned bundle is always the
 * config file's directory — every other module resolves relative paths
 * against it, so the same TOML works whether invoked from a subdir or root.
 */
export interface LoadedConfig {
  config: CompactConfig;
  configPath: string;
  rootDir: string;
}

export async function loadConfig(
  explicitPath: string | undefined,
  cwd = process.cwd(),
): Promise<LoadedConfig> {
  const configPath = explicitPath
    ? resolveExplicit(explicitPath, cwd)
    : findUpward(cwd);
  if (!configPath) {
    throw new ConfigError(
      `compact.toml not found (searched upward from ${cwd}). Pass --config <path> or create one at the repo root.`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (e) {
    throw new ConfigError(
      `Failed to read ${configPath}: ${(e as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseToml(raw);
  } catch (e) {
    throw new ConfigError(
      `Invalid TOML in ${configPath}: ${(e as Error).message}`,
    );
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`compact.toml validation failed:\n${issues}`);
  }

  return {
    config: result.data,
    configPath,
    rootDir: dirname(configPath),
  };
}

function resolveExplicit(p: string, cwd: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  if (!existsSync(abs)) {
    throw new ConfigError(`--config path does not exist: ${abs}`);
  }
  return abs;
}

function findUpward(start: string): string | undefined {
  let dir = resolve(start);
  while (true) {
    const candidate = resolve(dir, 'compact.toml');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
