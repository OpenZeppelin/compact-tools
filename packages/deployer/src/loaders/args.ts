import { type ContractConfig, isFileRef } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { LoaderContext } from './context.ts';
import { RefResolver } from './ref-resolver.ts';

export type ArgsSource = 'cli' | 'inline' | 'file' | 'module' | 'empty';

/**
 * A contract's constructor argument list, hydrated from the highest-precedence
 * source available in `compact.toml` / CLI flags.
 *
 * The `source` field records *where* the values came from — useful for
 * debug logging without re-running the resolution logic.
 */
export class ConstructorArgs {
  readonly values: readonly unknown[];
  readonly source: ArgsSource;

  private constructor(values: readonly unknown[], source: ArgsSource) {
    this.values = values;
    this.source = source;
  }

  /**
   * Resolve args. Precedence (highest first):
   *  1. `override` (CLI `--args '[…]'`, parsed as JSON).
   *  2. Inline `args = [...]` array in TOML.
   *  3. `args = { file = "…" }` → JSON file (bigints encoded as `"123n"`).
   *  4. `args = { module = "…", export = "…" }` → ES module export (value
   *     or zero-arg function returning an array).
   *
   * Returns an instance with `values = []` and `source = 'empty'` when no
   * source supplies args.
   */
  static async load(
    contract: ContractConfig,
    rootDir: string,
    override?: string,
  ): Promise<ConstructorArgs> {
    if (override !== undefined) {
      return new ConstructorArgs(parseJsonArray(override, '--args'), 'cli');
    }
    const raw = contract.args;
    if (raw === undefined) return new ConstructorArgs([], 'empty');
    if (Array.isArray(raw)) return new ConstructorArgs(raw, 'inline');

    const resolver = new RefResolver<readonly unknown[]>(
      new LoaderContext(rootDir),
      'args',
    );
    const values = await resolver.resolve(
      raw,
      (text, path) => parseJsonArray(text, path),
      (value, path, exp) => {
        if (!Array.isArray(value)) {
          throw new ConfigError(
            `args: module ${path} export "${exp}" must be an array`,
          );
        }
        return value;
      },
    );
    return new ConstructorArgs(values, isFileRef(raw) ? 'file' : 'module');
  }

  get length(): number {
    return this.values.length;
  }
}

function parseJsonArray(text: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (_k, v) =>
      typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    );
  } catch (e) {
    throw new ConfigError(
      `args: invalid JSON at ${label}: ${(e as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ConfigError(`args at ${label} must be a JSON array`);
  }
  return parsed;
}
