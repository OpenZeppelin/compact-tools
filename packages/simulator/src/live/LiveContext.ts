import type { StateValue } from '@midnight-ntwrk/compact-runtime';

/**
 * The result shape the live adapter reads from a `callTx` invocation.
 *
 * Pinned against `@midnight-ntwrk/midnight-js-contracts`: the default
 * `handle.callTx[name](...args)` resolves to a `FinalizedCallTxData` whose
 * circuit return value lives at `.private.result`. A harness's
 * `FoundContract<C>['callTx']` is structurally assignable to this.
 */
export interface FinalizedCallResult {
  readonly private: { readonly result: unknown };
}

/**
 * The minimal slice of a deployed-contract handle the live adapter needs:
 * a `callTx` map from circuit name to an async tx submission.
 *
 * Kept structural so the package's runtime graph never imports midnight-js.
 * A harness's `FoundContract<C>` satisfies this without any cast.
 */
export interface DeployedTxHandle {
  readonly callTx: Record<
    string,
    (...args: unknown[]) => Promise<FinalizedCallResult>
  >;
}

/**
 * The injection seam between the package and a live Midnight node.
 *
 * Defined by the package, implemented by the caller's harness, which owns all
 * live infra (deploy, providers, wallet pool). The package's adapter
 * ({@link LiveBackend}) is a pure consumer of this interface and imports no
 * midnight-js itself.
 *
 * Parameterized only by `P` (private state): the contract type `C` and ledger
 * type `L` are erased into structural types ({@link DeployedTxHandle}) and the
 * shared `ledgerExtractor`, so a harness can implement this without fighting
 * midnight-js generics.
 *
 * @template P - Private state type.
 */
export interface LiveContext<P> {
  /** The address of the contract the harness already deployed. */
  readonly contractAddress: string;

  /**
   * Resolves a per-alias deployed-contract handle, signing with that alias's
   * prefunded wallet. `null` selects the default signer. Implementations should
   * cache handles per alias.
   *
   * @param alias - The caller alias, or `null` for the default signer.
   */
  handleFor(alias: string | null): Promise<DeployedTxHandle>;

  /**
   * Reads the current public contract state from the indexer as a `StateValue`,
   * ready to feed the shared `ledgerExtractor`. Implementations should
   * absorb bounded indexer lag so read-after-write is stable.
   */
  queryLedger(): Promise<StateValue>;

  /**
   * Reads the contract's private state from the private-state provider (read
   * parity).
   */
  queryPrivateState(): Promise<P>;

  /**
   * Optional: writes the whole private state to the harness's private-state
   * provider, so the NEXT impure `callTx` proves against it. Each `callTx`
   * reads private state fresh from the provider (midnight-js `getStates` →
   * `privateStateProvider.get`), so no handle invalidation is needed.
   *
   * Omit to opt out of mutation — {@link LiveBackend} then throws
   * `PRIVATE_STATE_MUTATION_UNSUPPORTED`, so a spec that mutates fails loudly
   * rather than silently proving against stale state.
   *
   * Faithful for any client-controlled field of `P` (secret keys, cached
   * plaintexts, seeds, nonces) — injecting a hostile/stale value and asserting
   * the resulting rejection or handled behavior mirrors a real client. The one
   * thing it cannot do is fabricate on-chain state (`L`): a private state that
   * presupposes an on-chain event that never happened will not make a happy
   * path succeed on a live node.
   *
   * @param state - The new private state `P`.
   */
  setPrivateState?(state: P): Promise<void>;
}
