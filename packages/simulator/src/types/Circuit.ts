import type { CircuitContext } from '@midnight-ntwrk/compact-runtime';

/**
 * Extracts pure circuits from a contract type.
 * Pure circuits are those in `circuits` but not in `impureCircuits`.
 */
export type ExtractPureCircuits<TContract> = TContract extends {
  circuits: infer TCircuits;
  impureCircuits: infer TImpureCircuits;
}
  ? Omit<TCircuits, keyof TImpureCircuits>
  : never;

/**
 * Extracts impure circuits from a contract type.
 * Impure circuits are those in `impureCircuits`.
 */
export type ExtractImpureCircuits<TContract> = TContract extends {
  impureCircuits: infer TImpureCircuits;
}
  ? TImpureCircuits
  : never;

/**
 * The `result` a circuit yields, whether it returns `CircuitResults` directly
 * (compact-runtime 0.16) or a promise of it (0.18 and later).
 */
type CircuitResult<Ret> = Awaited<Ret> extends { result: infer R } ? R : never;

/**
 * Transforms circuit functions by removing the explicit `CircuitContext` parameter.
 *
 * Each original circuit function has signature:
 * `(ctx: CircuitContext<TState>, ...args) => Promise<{ result: R; context: CircuitContext<TState> }>`
 *
 * The transformed function takes the same parameters except the context,
 * and returns the `result` directly.
 */
export type ContextlessCircuits<Circuits, TState> = {
  [K in keyof Circuits]: Circuits[K] extends (
    ctx: CircuitContext<TState>,
    ...args: infer P
  ) => infer Ret
    ? (...args: P) => CircuitResult<Ret>
    : never;
};

/**
 * Async sibling of {@link ContextlessCircuits}, used by `createBackendSimulator`.
 *
 * Identical to {@link ContextlessCircuits} except every circuit returns
 * `Promise<R>` instead of `R`. This is the type-level half of dry↔live parity:
 * the dry backend wraps its synchronous result in `Promise.resolve`,
 * the live backend awaits the network, and spec code is uniform `await` across
 * both. A circuit can never return a bare value on one backend and a `Promise`
 * on the other.
 */
export type AsyncCircuits<Circuits, TState> = {
  [K in keyof Circuits]: Circuits[K] extends (
    ctx: CircuitContext<TState>,
    ...args: infer P
  ) => infer Ret
    ? (...args: P) => Promise<CircuitResult<Ret>>
    : never;
};
