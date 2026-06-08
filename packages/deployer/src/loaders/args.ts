import { type ContractConfig, isFileRef } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import {
  loadConstructorParamNames,
  reorderNamedArgs,
} from './constructor-meta.ts';
import { LoaderContext } from './context.ts';
import { RefResolver } from './ref-resolver.ts';

export type ArgsSource = 'cli' | 'inline' | 'file' | 'module' | 'api' | 'empty';

/** Constructor args hydrated from CLI / TOML. `source` records the winning origin. */
export class ConstructorArgs {
  readonly values: readonly unknown[];
  readonly source: ArgsSource;

  private constructor(values: readonly unknown[], source: ArgsSource) {
    this.values = values;
    this.source = source;
  }

  /**
   * Precedence: programmatic `DeployerOptions.args` > `--args '[…]'`
   * (JSON) > inline TOML array > `args = { file }` (JSON, `"123n"`
   * revived as bigint) > `args = { module, export }` (value or
   * zero-arg function). Empty result yields `source = 'empty'`.
   *
   * Programmatic args may be either a positional array or a named
   * object. Named objects are reordered to match the artifact's
   * constructor by parsing `<artifactPath>/contract/index.d.ts` for
   * the parameter order; `artifactPath` must be supplied when the
   * caller may pass a named-object form.
   */
  static async load(
    contract: ContractConfig,
    rootDir: string,
    override?: string,
    apiArgs?: readonly unknown[] | Record<string, unknown>,
    artifactPath?: string,
  ): Promise<ConstructorArgs> {
    if (apiArgs !== undefined) {
      if (Array.isArray(apiArgs)) {
        return new ConstructorArgs(apiArgs, 'api');
      }
      if (artifactPath === undefined) {
        throw new ConfigError(
          'named-object args require the artifact path; pass it via Deployer.prepare or use a positional array',
        );
      }
      const paramNames = loadConstructorParamNames(artifactPath);
      const reordered = reorderNamedArgs(
        apiArgs as Record<string, unknown>,
        paramNames,
      );
      return new ConstructorArgs(reordered, 'api');
    }
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
