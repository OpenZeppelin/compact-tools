import type { StateValue } from '@midnight-ntwrk/compact-runtime';
import type { Backend, BackendKind, CircuitKind } from '../backend/Backend.js';
import type { SyncSimulator } from '../backend/DryBackend.js';
import type { Signers } from '../signers/Signers.js';
import type { LiveContext } from './LiveContext.js';

/** The error thrown when witnesses are swapped on the live backend. */
export const WITNESS_OVERRIDE_UNSUPPORTED =
  'witness override unsupported on live backend';

/** The error thrown when private state is mutated on the live backend. */
export const PRIVATE_STATE_MUTATION_UNSUPPORTED =
  'private-state mutation unsupported on live backend';

/**
 * Dependencies the live adapter is constructed with by `createBackendSimulator`.
 *
 * @template P - Private state type.
 * @template L - Public ledger state type.
 */
export interface LiveBackendDeps<P, L> {
  /** The caller-supplied live world (handles + readers). */
  ctx: LiveContext<P>;
  /**
   * A local in-memory simulator used solely to evaluate pure circuits (D2).
   * Never deployed on-chain; pure circuits are state- and
   * caller-independent, so its seed state does not affect results.
   */
  pureSim: SyncSimulator<P, L>;
  /** Alias resolver, used here for the live signer cap. */
  signers: Signers;
  /** The shared ledger extractor, applied to indexer state for parity. */
  ledgerExtractor: (state: StateValue) => L;
}

/**
 * The live backend: a thin adapter that routes operations to an injected
 * {@link LiveContext} and normalizes results to match dry.
 *
 * It imports no midnight-js — all node wiring lives behind the
 * {@link LiveContext} seam. Routing follows pure/impure, not read/write
 * (D2): pure circuits run locally on the JS artifact, impure circuits
 * submit a tx.
 *
 * @template P - Private state type.
 * @template L - Public ledger state type.
 */
export class LiveBackend<P, L> implements Backend<P, L> {
  readonly kind: BackendKind = 'live';

  private readonly ctx: LiveContext<P>;
  private readonly pureSim: SyncSimulator<P, L>;
  private readonly signers: Signers;
  private readonly ledgerExtractor: (state: StateValue) => L;

  /** Caller active for all subsequent calls until changed. */
  private persistentAlias: string | null = null;
  /** Caller active for the next call only, then reverts. */
  private singleAlias: string | null = null;
  private hasSingle = false;

  constructor(deps: LiveBackendDeps<P, L>) {
    this.ctx = deps.ctx;
    this.pureSim = deps.pureSim;
    this.signers = deps.signers;
    this.ledgerExtractor = deps.ledgerExtractor;
  }

  get contractAddress(): string {
    return this.ctx.contractAddress;
  }

  /**
   * Pure circuits evaluate locally on the JS artifact (no tx); impure circuits
   * submit a tx via the per-alias handle and the result is normalized from
   * `FinalizedCallTxData.private.result` to the bare `R` dry returns.
   */
  async call(
    kind: CircuitKind,
    name: string,
    args: unknown[],
  ): Promise<unknown> {
    if (kind === 'pure') {
      const fn = this.pureSim.circuits.pure[name];
      if (typeof fn !== 'function') {
        throw new Error(`unknown pure circuit "${name}"`);
      }
      const result = fn(...args);
      this.consumeSingle();
      return result;
    }

    const alias = this.activeAlias();
    const handle = await this.ctx.handleFor(alias);
    const txFn = handle.callTx[name];
    if (typeof txFn !== 'function') {
      throw new Error(`unknown impure circuit "${name}"`);
    }
    // Unwrap callTx's { public, private: { result } } to the bare R.
    // The assert message inside any rejection is preserved verbatim —
    // we await directly and never catch/rewrite it.
    const finalized = await txFn(...args);
    this.consumeSingle();
    return finalized.private.result;
  }

  /** Same extractor as dry, applied to indexer-sourced state. */
  async getPublicState(): Promise<L> {
    return this.ledgerExtractor(await this.ctx.queryLedger());
  }

  /** Read parity via the private-state provider. */
  async getPrivateState(): Promise<P> {
    return this.ctx.queryPrivateState();
  }

  async getContractState(): Promise<StateValue> {
    return this.ctx.queryLedger();
  }

  /**
   * Mid-test private-state mutation does not faithfully reproduce on live.
   * Throws so such specs are explicitly guarded with `isLiveBackend()`
   * rather than silently passing against unchanged state.
   */
  setPrivateState(_privateState: P): void {
    throw new Error(PRIVATE_STATE_MUTATION_UNSUPPORTED);
  }

  /**
   * Validates the alias against the prefunded pool and records it.
   * `'single'` applies to the next call then reverts; `'persistent'` holds until
   * changed. The lifecycle mirrors dry's `callerOverride` /
   * `persistentCallerOverride`.
   */
  setCaller(alias: string | null, mode: 'single' | 'persistent'): void {
    if (alias !== null) this.signers.assertLiveAliasAllowed(alias);
    if (mode === 'persistent') {
      this.persistentAlias = alias;
    } else {
      this.singleAlias = alias;
      this.hasSingle = true;
    }
  }

  /** Witnesses bind at deploy and cannot be swapped mid-test. */
  overrideWitness(_key: PropertyKey, _fn: unknown): void {
    throw new Error(WITNESS_OVERRIDE_UNSUPPORTED);
  }

  /** Witnesses bind at deploy and cannot be swapped mid-test. */
  setWitnesses(_witnesses: unknown): void {
    throw new Error(WITNESS_OVERRIDE_UNSUPPORTED);
  }

  /** Reads the local witness set (used for pure-circuit evaluation). */
  getWitnesses(): unknown {
    return this.pureSim.witnesses;
  }

  /** The alias active for the next call: single-shot takes priority over persistent. */
  private activeAlias(): string | null {
    return this.hasSingle ? this.singleAlias : this.persistentAlias;
  }

  /** Clears the single-shot caller after a call, reverting to persistent/default. */
  private consumeSingle(): void {
    if (this.hasSingle) {
      this.hasSingle = false;
      this.singleAlias = null;
    }
  }
}
