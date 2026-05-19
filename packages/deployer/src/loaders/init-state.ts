import { type FileOrModuleRef } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { LoaderContext } from './context.ts';
import { RefResolver } from './ref-resolver.ts';

/**
 * The initial private-state value passed to a contract's constructor.
 *
 * `load` returns `undefined` when `[contracts.X].init_private_state` is
 * omitted — a contract either has private state or it doesn't, and we
 * surface that distinction at the type level rather than via a sentinel
 * `value`.
 */
export class InitialPrivateState {
  readonly value: unknown;

  private constructor(value: unknown) {
    this.value = value;
  }

  /**
   * Source is either `{ file }` (JSON, with `"123n"` strings revived as
   * bigints) or `{ module, export }` (TS/JS module, value or zero-arg
   * function).
   */
  static async load(
    ref: FileOrModuleRef | undefined,
    rootDir: string,
  ): Promise<InitialPrivateState | undefined> {
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
