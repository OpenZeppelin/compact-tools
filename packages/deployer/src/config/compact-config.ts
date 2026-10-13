import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { ZodIssue } from 'zod';
import { ConfigError } from '../errors.ts';
import {
  indexSources,
  keyKind,
  type ResolvedEntry,
  resolveEntry,
  type SourceIndex,
  sourceOf,
} from './patterns.ts';
import {
  type CompactConfigData,
  type ContractConfig,
  configSchema,
  contractSchema,
  type NetworkConfig,
  type WalletConfig,
} from './schema.ts';

/**
 * Parsed + validated `compact.toml` with the resolved project root.
 * Single source of truth for the pipeline; `network` / `contract`
 * lookups throw {@link ConfigError} with the available set on miss.
 */
export class CompactConfig {
  readonly configPath: string;
  /**
   * Directory `compact.toml` was loaded from, and the anchor for every
   * path the deployer writes: the `.states/` wallet-cache snapshots and
   * the LevelDB private-state store both hang off it. State therefore
   * belongs to the project rather than to whichever directory the user
   * happened to run `compact-deploy` from.
   */
  readonly rootDir: string;
  readonly #data: CompactConfigData;
  /** Set when a directory pattern exists. */
  readonly #sources: SourceIndex | undefined;
  readonly #resolved = new Map<string, ContractConfig>();

  private constructor(
    data: CompactConfigData,
    configPath: string,
    sources: SourceIndex | undefined,
  ) {
    this.#data = data;
    this.configPath = configPath;
    this.rootDir = dirname(configPath);
    this.#sources = sources;
  }

  /** Walks up from `cwd` Foundry-style when `explicitPath` is omitted. */
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
      throw new ConfigError(
        `compact.toml validation failed:\n${formatIssues(result.error.issues)}`,
      );
    }

    const { contracts, profile } = result.data;
    const sources =
      profile.src_dir !== undefined &&
      Object.keys(contracts).some((key) => keyKind(key) === 'directory')
        ? await indexSources(resolve(dirname(configPath), profile.src_dir))
        : undefined;
    const config = new CompactConfig(result.data, configPath, sources);
    // With a directory pattern, `configSchema` cannot check exact entries:
    // whether the pattern applies needs the source index.
    if (sources) {
      for (const name of config.listContracts()) config.contract(name);
    }
    return config;
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

  /** Whether any `[contracts]` key, exact or pattern, applies to `name`. */
  hasContract(name: string): boolean {
    return this.#resolve(name) !== undefined;
  }

  listNetworks(): string[] {
    return Object.keys(this.#data.networks);
  }

  /** Names with an exact `[contracts.X]` key. */
  listContracts(): string[] {
    return Object.keys(this.#data.contracts).filter(
      (key) => keyKind(key) === 'exact',
    );
  }

  /** Name and directory pattern keys, in file order. */
  listPatterns(): string[] {
    return Object.keys(this.#data.contracts).filter(
      (key) => keyKind(key) !== 'exact',
    );
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

  /** Merges every `[contracts]` key that applies to `name`, then validates the result. */
  contract(name: string): ContractConfig {
    const cached = this.#resolved.get(name);
    if (cached) return cached;
    const resolved = this.#resolve(name);
    if (!resolved) {
      const available = [
        ...this.listContracts(),
        ...this.listPatterns().map((key) => `"${key}"`),
      ].join(', ');
      const noSource =
        this.#sources && !this.#sources.byName.has(name)
          ? ` (no ${name}.compact under ${this.#sources.dir})`
          : '';
      throw new ConfigError(
        `Contract "${name}" not defined. Available: ${available}${noSource}`,
      );
    }
    const result = contractSchema.safeParse(resolved.entry);
    if (!result.success) {
      const keys = resolved.keys.map((key) => `"${key}"`).join(', ');
      throw new ConfigError(
        `compact.toml validation failed for contract "${name}" (from ${keys}):\n${formatIssues(result.error.issues, ['contracts', name])}`,
      );
    }
    this.#resolved.set(name, result.data);
    return result.data;
  }

  #resolve(name: string): ResolvedEntry | undefined {
    const source = this.#sources && sourceOf(name, this.#sources);
    return resolveEntry(name, this.#data.contracts, source);
  }
}

function formatIssues(
  issues: readonly ZodIssue[],
  prefix: readonly (string | number)[] = [],
): string {
  return issues
    .map((i) => {
      // A TOML document always parses to a table, so an issue can
      // never land at the empty root path.
      /* v8 ignore next */
      const at = [...prefix, ...i.path].join('.') || '(root)';
      return `  - ${at}: ${i.message}`;
    })
    .join('\n');
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
