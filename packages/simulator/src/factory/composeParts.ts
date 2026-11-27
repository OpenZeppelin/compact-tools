import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';

/** A factory for one part of a witness set or private state. */
export type PartFactory<T extends object = object> = () => T;

/** One factory, or a list of factories whose results are merged. */
export type Parts<F extends PartFactory = PartFactory> = F | readonly F[];

/**
 * The merged result of a union of part factories: the intersection of their
 * results. A factory that returns a union keeps it.
 */
export type Composed<F extends PartFactory> = (
  F extends unknown
    ? (result: ReturnType<F>) => void
    : never
) extends (result: infer I) => void
  ? I
  : never;

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

/** The merged witness set of a union of witness part factories. */
export type ComposedWitnesses<F extends PartFactory> = (
  F extends unknown
    ? (
        result: {
          [K in keyof ReturnType<F>]: ComposedWitness<ReturnType<F>[K]>;
        },
      ) => void
    : never
) extends (result: infer I) => void
  ? I
  : never;

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

/** Own enumerable keys, symbols included. */
const ownEnumerableKeys = (value: object): PropertyKey[] =>
  Reflect.ownKeys(value).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(value, key),
  );

/** The factories {@link composeWitnesses} returned. */
const composedWitnesses = new WeakSet<PartFactory>();

/** Replaces each {@link composeWitnesses} factory with its parts. */
function flattenWitnesses(parts: readonly PartFactory[]): PartFactory[] {
  return parts.flatMap((part) =>
    composedWitnesses.has(part)
      ? flattenWitnesses((part as ComposedFactory<object, PartFactory[]>).parts)
      : [part],
  );
}

/**
 * The private-state keys a witness part owns: those of the state its optional
 * `privateState` factory returns. None when it declares no factory.
 */
function ownedKeys(part: PartFactory): PropertyKey[] {
  const factory = (part as { privateState?: unknown }).privateState;
  if (typeof factory !== 'function') return [];
  const state: unknown = factory();
  return isRecord(state) ? ownEnumerableKeys(state) : [];
}

/**
 * Wraps a part's witness so the state it returns is written over the whole
 * state. An owned key the returned state omits is deleted.
 */
function mergingWitness(
  part: object,
  key: PropertyKey,
  owned: readonly PropertyKey[],
): unknown {
  const witness = (part as Record<PropertyKey, unknown>)[key];
  if (typeof witness !== 'function') return witness;
  return (context: WitnessContext<unknown, unknown>, ...args: unknown[]) => {
    const [next, value] = witness.call(part, context, ...args) as [
      unknown,
      unknown,
    ];
    const current = context.privateState;
    if (!isRecord(current) || !isRecord(next)) return [next, value];
    const merged: Record<PropertyKey, unknown> = { ...current, ...next };
    for (const ownedKey of owned) {
      if (!Object.hasOwn(next, ownedKey)) delete merged[ownedKey];
    }
    return [merged, value];
  };
}

/**
 * Calls every part and merges the results. A key two parts define throws.
 * Each key is an own data property, so a `__proto__` key stays a key.
 */
function mergeParts(
  kind: PartKind,
  parts: readonly PartFactory[],
): Record<PropertyKey, unknown> {
  const merged: Record<PropertyKey, unknown> = {};
  const owners = new Map<PropertyKey, number>();
  parts.forEach((part, index) => {
    const value = part();
    const owned = kind === 'witness' ? ownedKeys(part) : [];
    const keys =
      kind === 'witness' ? witnessKeys(value) : ownEnumerableKeys(value);
    for (const key of keys) {
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `${kind} "${String(key)}" is defined by both ${label(parts[owner], owner)} and ${label(part, index)}`,
        );
      }
      owners.set(key, index);
      Object.defineProperty(merged, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value:
          kind === 'witness'
            ? mergingWitness(value, key, owned)
            : (value as Record<PropertyKey, unknown>)[key],
      });
    }
  });
  return merged;
}

/**
 * Builds the merged factory. Two or more parts are called once here, so a
 * clash throws where the parts are declared. A {@link composeWitnesses}
 * factory among witness parts is merged as its parts, so each witness is
 * wrapped once.
 */
function composeParts(
  kind: PartKind,
  parts: readonly PartFactory[],
): ComposedFactory<object, readonly PartFactory[]> {
  const list = Object.freeze([...parts]);
  const merged = kind === 'witness' ? flattenWitnesses(list) : list;
  if (merged.length > 1) mergeParts(kind, merged);
  const factory = () => mergeParts(kind, merged);
  return Object.defineProperty(factory, 'parts', { value: list }) as never;
}

/**
 * Merges witness factories into one, e.g. a module's witnesses and its
 * authenticator's. Throws here if two parts define the same witness.
 *
 * A part's witness reads and returns its own part of the private state. The
 * merged witness writes the returned part over the whole state, so other
 * parts' keys stay. A part that names its private-state factory owns that
 * factory's keys: its witnesses return that whole state, and an optional owned
 * key they omit is deleted:
 * `Object.assign(AuthWitnesses, { privateState: AuthPrivateState.generate })`.
 */
export function composeWitnesses<const F extends readonly PartFactory[]>(
  ...parts: F
): ComposedFactory<ComposedWitnesses<F[number]> & object, F> {
  const factory = composeParts('witness', parts);
  composedWitnesses.add(factory);
  return factory as never;
}

/**
 * Merges private-state factories into one. Throws here if two parts define
 * the same key. Each part returns a plain object.
 */
export function composePrivateState<const F extends readonly PartFactory[]>(
  ...parts: F
): ComposedFactory<Composed<F[number]> & object, F> {
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
