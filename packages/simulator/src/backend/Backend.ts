import type { StateValue } from '@midnight-ntwrk/compact-runtime';

/**
 * Identifies which execution backend a simulator is bound to.
 *
 * Resolved once at construction time and fixed for the simulator's lifetime.
 * There is no runtime toggle: a `'dry'` simulator never becomes
 * `'live'` or vice versa.
 */
export type BackendKind = 'dry' | 'live';

/**
 * Whether a circuit runs locally on the JS artifact (`'pure'`) or, in live mode,
 * is submitted as a transaction to the node (`'impure'`).
 *
 * Locality follows the pure/impure distinction, NOT read/write (D2):
 * a read implemented as an impure circuit (e.g. `owner()`) still hits the node
 * in live mode.
 */
export type CircuitKind = 'pure' | 'impure';

/**
 * The execution seam that genuinely differs between the in-memory simulator and
 * a live Midnight node.
 *
 * `createBackendSimulator` builds the async circuit proxies, caller helpers, and
 * state getters on top of this interface; the backend itself stays dumb. Every
 * operation is async so spec code is uniform `await` across both backends:
 * {@link DryBackend} resolves in memory,
 * the live adapter awaits the network.
 *
 * @template P - Private state type.
 * @template L - Public ledger state type.
 */
export interface Backend<P, L> {
  /** The backend this instance is bound to. */
  readonly kind: BackendKind;

  /** The deployed contract's address. */
  readonly contractAddress: string;

  /**
   * Invokes a circuit. Pure circuits run locally on the JS artifact in both
   * modes; impure circuits run locally in dry and submit a tx in live (D2).
   * The live adapter normalizes the result to the bare `R` that dry
   * returns, so an assertion on the return value is identical across
   * backends.
   *
   * @param kind - Whether the circuit is pure or impure.
   * @param name - The circuit name.
   * @param args - The circuit arguments.
   * @returns The bare circuit result `R`, normalized to match dry.
   */
  call(kind: CircuitKind, name: string, args: unknown[]): Promise<unknown>;

  /**
   * Extracts the public ledger state. Both backends apply the same
   * `ledgerExtractor` — over the in-memory context in dry, over the
   * indexer-sourced state in live.
   */
  getPublicState(): Promise<L>;

  /**
   * Reads the private state `P`. Read parity holds across backends;
   * mutation parity does not (see {@link overrideWitness} and the private-state
   * mutation asymmetry documented on the live adapter).
   */
  getPrivateState(): Promise<P>;

  /** Returns the raw contract `StateValue` (the input to `ledgerExtractor`). */
  getContractState(): Promise<StateValue>;

  /**
   * Replaces the whole private state `P`. Dry mutates the in-memory context;
   * live writes to the harness's private-state provider so the next impure
   * `callTx` proves against it but only if the injected `LiveContext`
   * implements `setPrivateState`; otherwise it throws
   * `PRIVATE_STATE_MUTATION_UNSUPPORTED` (from the live backend).
   *
   * Async across backends for uniform `await`: dry resolves in memory,
   * live awaits the provider write.
   *
   * @param privateState - The new private state `P`.
   */
  setPrivateState(privateState: P): Promise<void>;

  /**
   * Sets the caller identity for subsequent circuit calls.
   *
   * The mode lifecycle matches across backends: `'single'` applies the
   * caller to the next call then reverts to the default signer; `'persistent'`
   * keeps it until changed. `null` clears the override (default signer).
   *
   * @param alias - The caller alias (e.g. `'OWNER'`), or `null` for the default signer.
   * @param mode - `'single'` (one call) or `'persistent'` (until changed).
   */
  setCaller(alias: string | null, mode: 'single' | 'persistent'): void;

  /**
   * Replaces a single witness implementation.
   *
   * Dry recreates the contract with the new witness; the live adapter throws
   * `"witness override unsupported on live backend"` because witnesses bind at
   * deploy and cannot be swapped mid-test.
   *
   * @param key - The witness key to override.
   * @param fn - The new witness implementation.
   */
  overrideWitness(key: PropertyKey, fn: unknown): void;

  /**
   * Replaces the whole witness set. Dry recreates the contract; the live adapter
   * throws the same message as {@link overrideWitness}.
   *
   * @param witnesses - The new witness set.
   */
  setWitnesses(witnesses: unknown): void;

  /** Returns the current witness set (read parity; live reads the local set). */
  getWitnesses(): unknown;
}
