import {
  type FileOrModuleRef,
  isFileRef,
  isModuleRef,
} from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import type { LoaderContext } from './context.ts';

/** Resolve a `{ file }` / `{ module, export }` ref to a typed value via caller-supplied parse + validate callbacks. */
export class RefResolver<T> {
  readonly #ctx: LoaderContext;
  readonly #label: string;

  constructor(ctx: LoaderContext, label: string) {
    this.#ctx = ctx;
    this.#label = label;
  }

  async resolve(
    ref: FileOrModuleRef,
    parseFile: (text: string, path: string) => T,
    validateExport: (value: unknown, path: string, exportName: string) => T,
  ): Promise<T> {
    if (isFileRef(ref)) {
      const { text, path } = await this.#ctx.readText(ref.file, this.#label);
      return parseFile(text, path);
    }
    if (isModuleRef(ref)) {
      const { mod, path } = await this.#ctx.importModule(
        ref.module,
        this.#label,
      );
      const exported = mod[ref.export];
      const resolved =
        typeof exported === 'function'
          ? await (exported as () => unknown)()
          : exported;
      return validateExport(resolved, path, ref.export);
    }
    throw new ConfigError(
      `${this.#label}: must be { file } or { module, export }`,
    );
  }
}
