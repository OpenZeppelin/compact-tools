/** A factory for one part of a witness set or private state. */
export type PartFactory<T extends object = object> = () => T;

/** One factory, or a list of factories whose results are merged. */
export type Parts<F extends PartFactory = PartFactory> = F | readonly F[];

type UnionToIntersection<U> = (
  U extends unknown
    ? (arg: U) => void
    : never
) extends (arg: infer I) => void
  ? I
  : never;

/**
 * The merged result of a union of part factories: the intersection of their
 * results.
 */
export type Composed<F extends PartFactory> = UnionToIntersection<
  ReturnType<F>
>;

const label = (part: PartFactory, index: number): string =>
  part.name ? `"${part.name}"` : `part ${index}`;

/**
 * Builds one factory that calls every part and merges the results. A key two
 * parts both return throws, naming the key and both parts.
 */
function composeParts(
  kind: string,
  parts: readonly PartFactory[],
): PartFactory {
  return () => {
    const merged: Record<string, unknown> = {};
    const owners = new Map<string, number>();
    parts.forEach((part, index) => {
      const value = part();
      for (const key of Object.keys(value)) {
        const owner = owners.get(key);
        if (owner !== undefined) {
          throw new Error(
            `${kind} "${key}" is defined by both ${label(parts[owner], owner)} and ${label(part, index)}`,
          );
        }
        owners.set(key, index);
      }
      Object.assign(merged, value);
    });
    return merged;
  };
}

/**
 * Merges witness factories into one, e.g. a module's witnesses and its
 * authenticator's. Two parts defining the same witness throw when the merged
 * factory runs.
 *
 * Each witness receives the whole merged private state and must return it
 * whole, updated with a spread (`[{ ...privateState, nonce }, value]`).
 */
export function composeWitnesses<const F extends readonly PartFactory[]>(
  ...parts: F
): PartFactory<Composed<F[number]> & object> {
  return composeParts('witness', parts) as PartFactory<
    Composed<F[number]> & object
  >;
}

/**
 * Merges private-state factories into one. Two parts defining the same key
 * throw when the merged factory runs.
 */
export function composePrivateState<const F extends readonly PartFactory[]>(
  ...parts: F
): PartFactory<Composed<F[number]> & object> {
  return composeParts('private state key', parts) as PartFactory<
    Composed<F[number]> & object
  >;
}

/** Normalizes {@link Parts} to one factory; `undefined` yields `{}`. */
export function partsFactory(
  kind: 'witness' | 'private state key',
  parts: Parts | undefined,
): PartFactory {
  if (parts === undefined) return () => ({});
  if (typeof parts === 'function') return parts;
  return composeParts(kind, parts);
}
