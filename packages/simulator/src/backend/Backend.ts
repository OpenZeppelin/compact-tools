import type { StateValue } from '@midnight-ntwrk/compact-runtime';

/**
 * Identifies which execution backend a simulator is bound to.
 *
 * Resolved once at construction time and fixed for the simulator's lifetime
 * (INV-8). There is no runtime toggle: a `'dry'` simulator never becomes
 * `'live'` or vice versa.
 */
export type BackendKind = 'dry' | 'live';

/**
 * Whether a circuit runs locally on the JS artifact (`'pure'`) or, in live mode,
 * is submitted as a transaction to the node (`'impure'`).
 *
 * Locality follows the pure/impure distinction, NOT read/write (D2, INV-16):
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
 * operation is async so spec code is uniform `await` across both backends
 * (INV-4): {@link DryBackend} wraps its synchronous results in `Promise.resolve`,
 * the live adapter awaits the network.
 *
 * @template P - Private state type.
 * @template L - Public ledger state type.
 */
export interface Backend<P, L> {
  /** The backend this instance is bound to (INV-8). */
  readonly kind: BackendKind;

  /** The deployed contract's address. */
  readonly contractAddress: string;

  /**
   * Invokes a circuit. Pure circuits run locally on the JS artifact in both
   * modes; impure circuits run locally in dry and submit a tx in live (D2,
   * INV-16). The live adapter normalizes the result to the bare `R` that dry
   * returns (INV-13), so an assertion on the return value is identical across
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
   * `ledgerExtractor` (INV-15) — over the in-memory context in dry, over the
   * indexer-sourced state in live.
   */
  getPublicState(): Promise<L>;

  /**
   * Reads the private state `P`. Read parity holds across backends (INV-18);
   * mutation parity does not (see {@link overrideWitness} and the private-state
   * mutation asymmetry documented on the live adapter).
   */
  getPrivateState(): Promise<P>;

  /** Returns the raw contract `StateValue` (the input to `ledgerExtractor`). */
  getContractState(): Promise<StateValue>;

  /**
   * Replaces the private state. Dry mutates the in-memory context (used by
   * per-module helpers like secret/nonce injection); live throws, because
   * mid-test private-state mutation is the documented dry↔live asymmetry
   * (INV-18). Guard such specs with `isLiveBackend()`.
   *
   * @param privateState - The new private state `P`.
   */
  setPrivateState(privateState: P): void;

  /**
   * Sets the caller identity for subsequent circuit calls.
   *
   * The mode lifecycle matches across backends (INV-17): `'single'` applies the
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
   * deploy and cannot be swapped mid-test (INV-7).
   *
   * @param key - The witness key to override.
   * @param fn - The new witness implementation.
   */
  overrideWitness(key: PropertyKey, fn: unknown): void;

  /**
   * Replaces the whole witness set. Dry recreates the contract; the live adapter
   * throws the same INV-7 message as {@link overrideWitness}.
   *
   * @param witnesses - The new witness set.
   */
  setWitnesses(witnesses: unknown): void;

  /** Returns the current witness set (read parity; live reads the local set). */
  getWitnesses(): unknown;
}
