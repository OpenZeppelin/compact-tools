import type { FileOrModuleRef } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { LoaderContext } from './context.ts';
import { RefResolver } from './ref-resolver.ts';

/** Initial private state for the contract constructor. `load` returns `undefined` when neither source gives one. */
export class InitialPrivateState {
  readonly value: unknown;

  private constructor(value: unknown) {
    this.value = value;
  }

  /**
   * An `inCode` value wins, and `ref` is then never read. Source: `{ file }`
   * (JSON with `"123n"` bigint strings) or `{ module, export }` (value or
   * zero-arg function).
   */
  static async load(
    ref: FileOrModuleRef | undefined,
    rootDir: string,
    inCode?: unknown,
  ): Promise<InitialPrivateState | undefined> {
    if (inCode !== undefined) return new InitialPrivateState(inCode);
    if (!ref) return undefined;

    const resolver = new RefResolver<unknown>(
      new LoaderContext(rootDir),
      'init_private_state',
    );
    const value = await resolver.resolve(
      ref,
      (text, path) => {
        try {
          return JSON.parse(text, bigintReviver);
        } catch (e) {
          throw new ConfigError(
            `init_private_state: invalid JSON at ${path}: ${(e as Error).message}`,
          );
        }
      },
      (v, path, exp) => {
        if (v === undefined) {
          throw new ConfigError(
            `init_private_state: module ${path} has no export "${exp}"`,
          );
        }
        return v;
      },
    );
    return new InitialPrivateState(value);
  }
}

function bigintReviver(_key: string, value: unknown): unknown {
  if (typeof value === 'string' && /^-?\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}
