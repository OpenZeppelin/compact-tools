import type {
  CoinPublicKey,
  StateValue,
} from '@midnight-ntwrk/compact-runtime';
import type { Signers } from '../signers/Signers.js';
import type { Backend, BackendKind, CircuitKind } from './Backend.js';

/**
 * The slice of a synchronous `createSimulator` instance that {@link DryBackend}
 * drives. Kept structural so the dry backend reuses the existing simulator
 * machinery without coupling to its concrete (anonymous) class.
 *
 * @template P - Private state type.
 * @template L - Public ledger state type.
 */
export interface SyncSimulator<P, L> {
  readonly contractAddress: string;
  callerOverride: CoinPublicKey | null;
  persistentCallerOverride: CoinPublicKey | null;
  readonly circuits: {
    pure: Record<string, (...args: unknown[]) => unknown>;
    impure: Record<string, (...args: unknown[]) => unknown>;
  };
  getPublicState(): L;
  getPrivateState(): P;
  getContractState(): StateValue;
  overrideWitness(key: PropertyKey, fn: unknown): void;
  witnesses: unknown;
  readonly circuitContextManager: { updatePrivateState(privateState: P): void };
}

/**
 * The in-memory backend: a thin async facade over the existing synchronous
 * `createSimulator` instance.
 *
 * Every operation delegates to the wrapped simulator and wraps the synchronous
 * result in a resolved promise (INV-4), so a circuit never returns a bare value
 * on dry but a `Promise` on live. Because all real work routes through the
 * unchanged synchronous path, dry behavior is preserved byte-for-byte (INV-19)
 * and is the parity reference the live backend is measured against (INV-12).
 *
 * @template P - Private state type.
 * @template L - Public ledger state type.
 */
export class DryBackend<P, L> implements Backend<P, L> {
  readonly kind: BackendKind = 'dry';

  private readonly sim: SyncSimulator<P, L>;
  private readonly signers: Signers;

  /**
   * @param sim - The wrapped synchronous simulator instance.
   * @param signers - Resolver used to turn caller aliases into deterministic keys.
   */
  constructor(sim: SyncSimulator<P, L>, signers: Signers) {
    this.sim = sim;
    this.signers = signers;
  }

  get contractAddress(): string {
    return this.sim.contractAddress;
  }

  /**
   * Runs a circuit on the in-memory contract. Accessing `circuits.{pure,impure}`
   * fresh on each call means a witness override (which rebuilds the wrapped
   * simulator's proxies) is picked up transparently.
   */
  async call(
    kind: CircuitKind,
    name: string,
    args: unknown[],
  ): Promise<unknown> {
    const proxy =
      kind === 'pure' ? this.sim.circuits.pure : this.sim.circuits.impure;
    const fn = proxy[name];
    if (typeof fn !== 'function') {
      throw new Error(`unknown ${kind} circuit "${name}"`);
    }
    return fn(...args);
  }

  async getPublicState(): Promise<L> {
    return this.sim.getPublicState();
  }

  async getPrivateState(): Promise<P> {
    return this.sim.getPrivateState();
  }

  async getContractState(): Promise<StateValue> {
    return this.sim.getContractState();
  }

  /** Mutates the in-memory private state (INV-18: dry supports mid-test mutation). */
  setPrivateState(privateState: P): void {
    this.sim.circuitContextManager.updatePrivateState(privateState);
  }

  /**
   * Resolves the alias to a deterministic key and applies it to the wrapped
   * simulator's override fields. `'single'` uses `callerOverride` (the existing
   * proxy auto-resets it after one call); `'persistent'` uses
   * `persistentCallerOverride` (INV-17).
   */
  setCaller(alias: string | null, mode: 'single' | 'persistent'): void {
    const key = alias === null ? null : this.signers.resolveDryKey(alias);
    if (mode === 'persistent') {
      this.sim.persistentCallerOverride = key;
    } else {
      this.sim.callerOverride = key;
    }
  }

  /** Delegates to the wrapped simulator, which recreates the contract (dry supports this). */
  overrideWitness(key: PropertyKey, fn: unknown): void {
    this.sim.overrideWitness(key, fn);
  }

  /** Delegates to the wrapped simulator's witness setter (dry supports this). */
  setWitnesses(witnesses: unknown): void {
    this.sim.witnesses = witnesses;
  }

  /** Returns the wrapped simulator's current witnesses. */
  getWitnesses(): unknown {
    return this.sim.witnesses;
  }
}
