/**
 * Witness module for the `PrivateCounter` fixture, resolved at deploy
 * time via `[contracts.PrivateCounter].witnesses = { module, export }`
 * in `compact.toml`. Mirrors the pattern in
 * `packages/simulator/test/fixtures/sample-contracts/witnesses/`.
 *
 * The deployer's loader calls `PrivateCounterWitnesses()` (with no
 * type-argument; generics are erased at runtime) and uses the returned
 * object to satisfy the `secret_delta` declaration in
 * `PrivateCounter.compact`. Each witness returns
 * `[updatedPrivateState, value]` per Compact's witness ABI.
 */
import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';

export type PrivateCounterState = {
  /** Secret value the circuit reads via `secret_delta()`. */
  delta: bigint;
};

export interface IPrivateCounterWitnesses<L, P> {
  secret_delta(context: WitnessContext<L, P>): [P, bigint];
}

export const PrivateCounterWitnesses = <L>(): IPrivateCounterWitnesses<
  L,
  PrivateCounterState
> => ({
  secret_delta(
    context: WitnessContext<L, PrivateCounterState>,
  ): [PrivateCounterState, bigint] {
    return [context.privateState, context.privateState.delta];
  },
});
