import {
  type CircuitContext,
  copyCircuitContext,
  type EncodedZswapLocalState,
  emptyZswapLocalState,
} from '@midnight-ntwrk/compact-runtime';
import { AbstractSimulator } from './AbstractSimulator.js';
import type { CircuitContextManager } from './CircuitContextManager.js';

const keyOf = (state: EncodedZswapLocalState): string =>
  Buffer.from(state.coinPublicKey.bytes).toString('hex');

/**
 * Each simulator's Zswap local states for coin public keys other than the
 * stored context's, by hex key.
 */
const callerZswapStates = new WeakMap<
  object,
  Map<string, EncodedZswapLocalState>
>();

/**
 * Enhanced base class for simulating Compact contract behavior with state management.
 *
 * Extends `AbstractSimulator` with:
 * - Simplified state management through `CircuitContextManager`
 * - Circuit context getters/setters that delegate to the state manager
 * - Caller context handling that respects both single-use and persistent overrides
 */
export abstract class ContractSimulator<P, L> extends AbstractSimulator<P, L> {
  /**
   * State manager that handles circuit context, private state, and contract state lifecycle.
   * Must be initialized by concrete subclasses in their constructor.
   */
  public circuitContextManager!: CircuitContextManager<P>;

  /** Retrieves the current public ledger state */
  abstract getPublicState(): L;

  /**
   * Constructs a circuit context with appropriate caller information.
   *
   * @notice ownPublicKey() is a witness value and MUST NOT be used
   * as an authentication mechanism. Any contract using ownPublicKey()
   * directly for access control is insecure. This method exists to
   * support circuits that use ownPublicKey() as an input to other
   * computations (e.g., commitment derivation).
   *
   * Checks for caller overrides in priority order:
   * 1. Single-use override (set via `as(caller)`), `null` included
   * 2. Persistent override (set via `setPersistentCaller(caller)`)
   * 3. Default caller context
   *
   * A caller other than the default one runs on its own Zswap local state.
   *
   * @returns A CircuitContext with the appropriate caller information applied
   */
  public getCallerContext(): CircuitContext<P> {
    const activeCaller =
      this.hasCallerOverride || this.callerOverride !== null
        ? this.callerOverride
        : this.persistentCallerOverride;
    const baseCtx = this.circuitContext;

    if (!activeCaller) {
      return baseCtx;
    }

    const fresh = emptyZswapLocalState(activeCaller);
    const key = keyOf(fresh);
    const base = baseCtx.callContext.currentZswapLocalState;
    if (base && keyOf(base) === key) {
      return baseCtx;
    }

    // compact-runtime 0.18: the caller-scoped fields live on `callContext`.
    // Copy (shallow-clones `callContext`) before overriding the Zswap local
    // state so the base context is left untouched.
    // `copyCircuitContext` is `@internal` upstream, so a patch release could
    // drop it; hand-rolling the copy is the worse option.
    // TODO: drop this note once the runtime makes it public.
    const ctx = copyCircuitContext(baseCtx) as CircuitContext<P>;
    const state = callerZswapStates.get(this)?.get(key) ?? fresh;
    // The runtime reads and writes both cells, so they must agree.
    ctx.callContext.currentZswapLocalState = state;
    ctx.zswapLocalStates[ctx.callContext.contractAddress] = state;
    return ctx;
  }

  /**
   * Stores the context an impure call returned. The Zswap local state of a
   * call made as another coin public key is kept under that key, for the next
   * call as it; the stored context keeps the default caller's.
   *
   * @param ctx - The context the circuit returned.
   */
  public commitCallContext(ctx: CircuitContext<P>): void {
    const base = this.circuitContext.callContext.currentZswapLocalState;
    const next = ctx.callContext.currentZswapLocalState;
    if (base && next && keyOf(base) !== keyOf(next)) {
      let states = callerZswapStates.get(this);
      if (!states) {
        states = new Map();
        callerZswapStates.set(this, states);
      }
      states.set(keyOf(next), next);
      ctx.callContext.currentZswapLocalState = base;
      ctx.zswapLocalStates[ctx.callContext.contractAddress] = base;
    }
    this.circuitContext = ctx;
  }

  /**
   * Gets the current circuit context from the state manager
   *
   * @returns The current circuit context
   */
  get circuitContext(): CircuitContext<P> {
    return this.circuitContextManager.getContext();
  }

  /** Updates the circuit context in the state manager */
  set circuitContext(ctx: CircuitContext<P>) {
    this.circuitContextManager.setContext(ctx);
  }
}
