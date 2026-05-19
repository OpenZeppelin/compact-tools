import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ConfigError } from '../errors.ts';
import {
  type CompactConfigData,
  type ContractConfig,
  configSchema,
  type NetworkConfig,
  type WalletConfig,
} from './schema.ts';

/**
 * A parsed and validated `compact.toml`, plus the resolved project root.
 *
 * Acts as the source of truth for the deploy pipeline — every loader and
 * provider derives its paths and target lookups from a single
 * `CompactConfig` instance. Lookup methods (`network`, `contract`) throw
 * {@link ConfigError} with the available set on miss.
 */
export class CompactConfig {
  readonly configPath: string;
  readonly rootDir: string;
  readonly #data: CompactConfigData;

  private constructor(data: CompactConfigData, configPath: string) {
    this.#data = data;
    this.configPath = configPath;
    this.rootDir = dirname(configPath);
  }

  /**
   * Find, parse, and validate `compact.toml` against the schema.
   *
   * When `explicitPath` is omitted the loader walks the directory tree
   * upward from `cwd` (Foundry-style) and the first match becomes the
   * project root. Pass `--config <path>` to override.
   */
  static async load(
    explicitPath?: string,
    cwd: string = process.cwd(),
  ): Promise<CompactConfig> {
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

    return new CompactConfig(result.data, configPath);
  }

  get defaultNetwork(): string | undefined {
    return this.#data.profile.default_network;
  }

  get artifactsDir(): string {
    return this.#data.profile.artifacts_dir;
  }

  get deploymentsDir(): string {
    return this.#data.profile.deployments_dir;
  }

  get wallet(): WalletConfig | undefined {
    return this.#data.wallet;
  }

  hasNetwork(name: string): boolean {
    return Object.hasOwn(this.#data.networks, name);
  }

  hasContract(name: string): boolean {
    return Object.hasOwn(this.#data.contracts, name);
  }

  listNetworks(): string[] {
    return Object.keys(this.#data.networks);
  }

  listContracts(): string[] {
    return Object.keys(this.#data.contracts);
  }

  network(name: string): NetworkConfig {
    const n = this.#data.networks[name];
    if (!n) {
      throw new ConfigError(
        `Network "${name}" not defined. Available: ${this.listNetworks().join(', ')}`,
      );
    }
    return n;
  }

  contract(name: string): ContractConfig {
    const c = this.#data.contracts[name];
    if (!c) {
      throw new ConfigError(
        `Contract "${name}" not defined. Available: ${this.listContracts().join(', ')}`,
      );
    }
    return c;
  }
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
