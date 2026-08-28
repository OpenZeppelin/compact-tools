import {
  type CircuitContext,
  type CoinPublicKey,
  type ConstructorContext,
  type ContractAddress,
  createCircuitContext,
  createConstructorContext,
} from '@midnight-ntwrk/compact-runtime';
import type { InitialStateResult } from '../types/Contract.js';

/**
 * A composable utility class for managing Compact contract state in simulations.
 *
 * Handles initialization and lifecycle management of the `CircuitContext`,
 * which includes private state, public (ledger) state, zswap local state, and transaction context.
 */
export class CircuitContextManager<P> {
  private _context?: CircuitContext<P>;

  /** The built context. Throws if read before {@link init} has been awaited. */
  get context(): CircuitContext<P> {
    if (!this._context) {
      throw new Error('CircuitContextManager: call init() before use');
    }
    return this._context;
  }

  set context(newContext: CircuitContext<P>) {
    this._context = newContext;
  }

  private readonly contract: {
    initialState: (
      ctx: ConstructorContext<P>,
      ...args: any[]
    ) => InitialStateResult<P> | Promise<InitialStateResult<P>>;
  };
  private readonly privateState: P;
  private readonly coinPK: CoinPublicKey;
  private readonly contractAddress: ContractAddress;
  private readonly time: number;
  private readonly contractArgs: any[];

  /**
   * Creates an instance of `CircuitContextManager`.
   *
   * @remarks compact-runtime 0.18 made `initialState` (and every circuit) async,
   * so the constructor only records inputs; the context is built by the async
   * {@link init}, which callers must await before using the manager.
   *
   * @param contract - A compiled Compact contract instance exposing `initialState()`
   * @param contract.initialState - Function that initializes contract state given a constructor context
   * @param privateState - The initial private state to inject into the contract
   * @param coinPK - The caller's coin public key
   * @param contractAddress - Optional override for the contract's address
   * @param time - Block time in seconds since the epoch, as the kernel's time
   *   operations observe it
   * @param contractArgs - Additional arguments to pass to the contract constructor
   */
  constructor(
    contract: {
      initialState: (
        ctx: ConstructorContext<P>,
        ...args: any[]
      ) => InitialStateResult<P> | Promise<InitialStateResult<P>>;
    },
    privateState: P,
    coinPK: CoinPublicKey,
    contractAddress: ContractAddress,
    time: number,
    ...contractArgs: any[]
  ) {
    this.contract = contract;
    this.privateState = privateState;
    this.coinPK = coinPK;
    this.contractAddress = contractAddress;
    this.time = time;
    this.contractArgs = contractArgs;
  }

  /**
   * Runs the contract constructor and builds the initial `CircuitContext`.
   * Must be awaited once, after construction, before any circuit call.
   */
  async init(): Promise<void> {
    const initCtx = createConstructorContext(this.privateState, this.coinPK);

    const {
      currentPrivateState,
      currentContractState,
      currentZswapLocalState,
    } = await this.contract.initialState(initCtx, ...this.contractArgs);

    // compact-runtime 0.18 restructured `CircuitContext` into a call-tree
    // (`callContext` + per-contract `queryContexts`/`gasCosts`). Build it via
    // the runtime's `createCircuitContext` factory rather than a hand-rolled
    // literal so every required field is populated correctly.
    this.context = createCircuitContext<P>(
      'circuit',
      this.contractAddress,
      currentZswapLocalState,
      currentContractState.data,
      currentPrivateState,
      undefined, // stateProvider: no cross-contract calls in the simulator
      undefined, // gasLimit: runtime default
      undefined, // costModel: runtime default
      this.time,
    );
  }

  /**
   * Retrieves the current `CircuitContext`
   *
   * @returns The current circuit context
   */
  getContext(): CircuitContext<P> {
    return this.context;
  }

  /**
   * Replaces the internal `CircuitContext` with a new one.
   *
   * @param newContext - The new circuit context to replace the current one
   */
  setContext(newContext: CircuitContext<P>) {
    this.context = newContext;
  }

  /**
   * Updates just the private state inside the existing context.
   *
   * @param newPrivateState - The new private state to set in the current context
   */
  updatePrivateState(newPrivateState: P) {
    this.context.callContext.currentPrivateState = newPrivateState;
  }
}
