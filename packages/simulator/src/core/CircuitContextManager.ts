import {
  type CircuitContext,
  type CoinPublicKey,
  type ConstructorContext,
  type ContractAddress,
  type ContractState,
  createCircuitContext,
  createConstructorContext,
  type EncodedZswapLocalState,
} from '@midnight-ntwrk/compact-runtime';

/**
 * A composable utility class for managing Compact contract state in simulations.
 *
 * Handles initialization and lifecycle management of the `CircuitContext`,
 * which includes private state, public (ledger) state, zswap local state, and transaction context.
 */
/** Shape of a compiled contract's constructor result (sync or async in 0.18). */
type InitialStateResult<P> = {
  currentPrivateState: P;
  currentContractState: ContractState;
  currentZswapLocalState: EncodedZswapLocalState;
};

export class CircuitContextManager<P> {
  // Assigned by the async `init()`; the manager is always constructed and then
  // awaited (`init`) before any circuit call reads the context.
  public context!: CircuitContext<P>;

  private readonly contract: {
    initialState: (
      ctx: ConstructorContext<P>,
      ...args: any[]
    ) => InitialStateResult<P> | Promise<InitialStateResult<P>>;
  };
  private readonly privateState: P;
  private readonly coinPK: CoinPublicKey;
  private readonly contractAddress: ContractAddress;
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
    ...contractArgs: any[]
  ) {
    this.contract = contract;
    this.privateState = privateState;
    this.coinPK = coinPK;
    this.contractAddress = contractAddress;
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
