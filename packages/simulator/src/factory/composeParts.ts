import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';

/** A factory for one part of a witness set or private state. */
export type PartFactory<T extends object = object> = () => T;

/** One factory, or a list of factories whose results are merged. */
export type Parts<F extends PartFactory = PartFactory> = F | readonly F[];

/**
 * A part's witness as the merged set runs it: it reads its own part of the
 * private state `Q` and returns the whole of `Q`.
 */
export type ComposedWitness<M> = M extends (
  context: WitnessContext<infer L, infer S>,
  ...args: infer A
) => [infer O, infer R]
  ? [O] extends [S]
    ? <Q extends S>(context: WitnessContext<L, Q>, ...args: A) => [Q, R]
    : M
  : M;

/**
 * The intersection of a tuple's element types. An element that is a union
 * stays a union.
 */
type IntersectPositions<T extends readonly unknown[]> = {
  [K in keyof T]: (value: T[K]) => void;
}[number] extends (value: infer I) => void
  ? I
  : never;

/** A part's witness set, each witness as the merged set runs it. */
type ComposedWitnessSet<R> = R extends unknown
  ? { [K in keyof R]: ComposedWitness<R[K]> }
  : never;

/**
 * The merged result of a tuple of part factories: across positions, the
 * intersection of what each position returns. A position typed `A | B`
 * contributes `ReturnType<A> | ReturnType<B>`.
 */
export type Composed<L extends readonly PartFactory[]> = IntersectPositions<{
  [K in keyof L]: L[K] extends PartFactory<infer R> ? R : never;
}>;

/** The merged witness set of a tuple of witness part factories. */
export type ComposedWitnesses<L extends readonly PartFactory[]> =
  IntersectPositions<{
    [K in keyof L]: L[K] extends PartFactory<infer R>
      ? ComposedWitnessSet<R>
      : never;
  }>;

/**
 * Rejects a list whose length is not fixed, e.g. a spread `(A | B)[]`: it can
 * lack a part at run time.
 */
export type TupleOnly<L extends readonly unknown[]> = number extends L['length']
  ? { readonly notATuple: 'list the parts in an array literal or a tuple' }
  : unknown;

/** A factory merged from parts, which it keeps in order. */
export type ComposedFactory<
  T extends object,
  F extends readonly PartFactory[],
> = PartFactory<T> & { readonly parts: F };

type PartKind = 'witness' | 'private state key';

const label = (part: PartFactory, index: number): string =>
  part.name ? `part ${index} ("${part.name}")` : `part ${index}`;

/** Witness names a part defines, its prototype chain included. */
function witnessKeys(value: object): string[] {
  const keys = new Set<string>();
  for (
    let level: object | null = value;
    level !== null && level !== Object.prototype;
    level = Object.getPrototypeOf(level)
  ) {
    for (const key of Object.getOwnPropertyNames(level)) {
      if (key !== 'constructor') keys.add(key);
    }
  }
  return [...keys];
}

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Wraps a part's witness so the slice it returns is written over the whole state. */
function mergingWitness(part: object, key: string): unknown {
  const witness = (part as Record<string, unknown>)[key];
  if (typeof witness !== 'function') return witness;
  return (context: WitnessContext<unknown, unknown>, ...args: unknown[]) => {
    const [next, value] = witness.call(part, context, ...args) as [
      unknown,
      unknown,
    ];
    const current = context.privateState;
    return [
      isRecord(current) && isRecord(next) ? { ...current, ...next } : next,
      value,
    ];
  };
}

/** Calls every part and merges the results. A key two parts define throws. */
function mergeParts(
  kind: PartKind,
  parts: readonly PartFactory[],
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const owners = new Map<string, number>();
  parts.forEach((part, index) => {
    const value = part();
    const keys = kind === 'witness' ? witnessKeys(value) : Object.keys(value);
    for (const key of keys) {
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `${kind} "${key}" is defined by both ${label(parts[owner], owner)} and ${label(part, index)}`,
        );
      }
      owners.set(key, index);
      merged[key] =
        kind === 'witness'
          ? mergingWitness(value, key)
          : (value as Record<string, unknown>)[key];
    }
  });
  return merged;
}

/**
 * Builds the merged factory. Two or more parts are called once here, so a
 * clash throws where the parts are declared.
 */
function composeParts(
  kind: PartKind,
  parts: readonly PartFactory[],
): ComposedFactory<object, readonly PartFactory[]> {
  const list = Object.freeze([...parts]);
  if (list.length > 1) mergeParts(kind, list);
  const factory = () => mergeParts(kind, list);
  return Object.defineProperty(factory, 'parts', { value: list }) as never;
}

/**
 * Merges witness factories into one, e.g. a module's witnesses and its
 * authenticator's. Throws here if two parts define the same witness.
 *
 * A part's witness reads and returns its own part of the private state. The
 * merged witness writes the returned part over the whole state.
 */
export function composeWitnesses<const F extends readonly PartFactory[]>(
  ...parts: F & TupleOnly<F>
): ComposedFactory<ComposedWitnesses<F> & object, F> {
  return composeParts('witness', parts) as never;
}

/**
 * Merges private-state factories into one. Throws here if two parts define
 * the same key. Each part returns a plain object.
 */
export function composePrivateState<const F extends readonly PartFactory[]>(
  ...parts: F & TupleOnly<F>
): ComposedFactory<Composed<F> & object, F> {
  return composeParts('private state key', parts) as never;
}

/** Normalizes {@link Parts} to one factory; `undefined` yields `{}`. */
export function partsFactory(
  kind: PartKind,
  parts: Parts | undefined,
): PartFactory {
  if (parts === undefined) return () => ({});
  if (typeof parts === 'function') return parts;
  return composeParts(kind, parts);
}
