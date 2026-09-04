import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { CircuitContextManager } from '../core/CircuitContextManager.js';
import { ContractSimulator } from '../core/ContractSimulator.js';
import type { IMinimalContract } from '../types/Contract.js';
import type {
  ContextlessCircuits,
  ExtractImpureCircuits,
  ExtractPureCircuits,
} from '../types/index.js';
import type { BaseSimulatorOptions } from '../types/Options.js';
import type { SimulatorConfig } from './SimulatorConfig.js';

/**
 * Internal in-memory simulator primitive.
 *
 * This is the engine the public {@link createSimulator} builds on: the dry
 * backend wraps an instance of this class, and the live backend uses one locally
 * to evaluate pure circuits. It is not the public testing API —
 * use {@link createSimulator} instead.
 *
 * Creates a class extending ContractSimulator with witness management, state
 * management, circuit proxy creation, and options handling.
 *
 * @param config - Configuration object defining how to create and manage the simulator
 * @returns A class constructor that can be extended to create specific simulators
 */
export function createDrySimulator<
  P,
  L,
  W,
  TContract extends IMinimalContract,
  TArgs extends readonly any[] = readonly any[],
>(config: SimulatorConfig<P, L, W, TContract, TArgs>) {
  return class GeneratedSimulator extends ContractSimulator<P, L> {
    contract: TContract;
    // Underscore-public, not private: declaration emit rejects private members
    // on this exported anonymous class (TS4094). Treat as internal.
    public _contractAddress?: string;
    public _witnesses: W;

    /**
     * The contract's address, read from the built context. Throws if read
     * before {@link init} has been awaited.
     */
    get contractAddress(): string {
      if (this._contractAddress === undefined) {
        throw new Error('Simulator: await init() before use');
      }
      return this._contractAddress;
    }

    /**
     * Creates a new simulator instance with explicit contract args and options
     */
    constructor(
      contractArgs: TArgs = [] as any,
      options: BaseSimulatorOptions<P, W> = {},
    ) {
      super();

      const {
        privateState = config.defaultPrivateState(),
        witnesses = config.witnessesFactory(),
        coinPK = '0'.repeat(64),
        contractAddress = dummyContractAddress(),
        // Fixed rather than wall-clock, so a run that reads `kernel.blockTime()`
        // is reproducible. Override via `options.time`.
        time = 0,
      } = options;

      this._witnesses = witnesses;
      this.contract = config.contractFactory(this._witnesses);

      const processedArgs = config.contractArgs(...contractArgs);

      this.circuitContextManager = new CircuitContextManager(
        this.contract,
        privateState,
        coinPK,
        contractAddress,
        time,
        ...processedArgs,
      );
    }

    /**
     * Runs the contract constructor and finalizes state. Must be awaited once,
     * after construction, before any circuit call. Split out from the
     * constructor because compact-runtime 0.18 made `initialState` async.
     */
    async init(): Promise<this> {
      await this.circuitContextManager.init();
      this._contractAddress =
        this.circuitContext.callContext.currentQueryContext.address;
      return this;
    }

    public _pureCircuitProxy?: ContextlessCircuits<
      ExtractPureCircuits<TContract>,
      P
    >;
    public _impureCircuitProxy?: ContextlessCircuits<
      ExtractImpureCircuits<TContract>,
      P
    >;

    /**
     * Gets the pure circuit proxy, creating it lazily if it doesn't exist.
     *
     * @returns The pure circuit proxy for executing read-only contract methods
     */
    public get pureCircuit(): ContextlessCircuits<
      ExtractPureCircuits<TContract>,
      P
    > {
      if (!this._pureCircuitProxy) {
        this._pureCircuitProxy = this.createPureCircuitProxy(
          this.contract.circuits as ExtractPureCircuits<TContract>,
          () => this.circuitContext,
        );
      }
      return this._pureCircuitProxy;
    }

    /**
     * Gets the impure circuit proxy, creating it lazily if it doesn't exist.
     *
     * @returns The impure circuit proxy for executing state-modifying contract methods
     */
    public get impureCircuit(): ContextlessCircuits<
      ExtractImpureCircuits<TContract>,
      P
    > {
      if (!this._impureCircuitProxy) {
        this._impureCircuitProxy = this.createImpureCircuitProxy(
          this.contract.impureCircuits as ExtractImpureCircuits<TContract>,
          () => this.getCallerContext(),
          (ctx) => {
            this.circuitContext = ctx;
          },
        );
      }
      return this._impureCircuitProxy;
    }

    /**
     * Gets both pure and impure circuit proxies.
     *
     * @returns Object containing both pure and impure circuit proxies
     */
    public get circuits() {
      return {
        pure: this.pureCircuit,
        impure: this.impureCircuit,
      };
    }

    /**
     * Resets cached circuit proxies, forcing re-initialization on next access.
     */
    public resetCircuitProxies(): void {
      this._pureCircuitProxy = undefined;
      this._impureCircuitProxy = undefined;
    }

    /**
     * Extracts the public ledger state from the current contract state.
     *
     * @returns The current public state of the contract
     */
    getPublicState(): L {
      return config.ledgerExtractor(
        this.circuitContext.callContext.currentQueryContext.state.state,
      );
    }

    // Common witness management methods
    /**
     * Gets the current witness functions.
     *
     * @returns The current witness function implementations
     */
    public get witnesses(): W {
      return this._witnesses;
    }

    /**
     * Sets new witness functions and recreates the contract with them.
     *
     * @param newWitnesses - The new witness function implementations to use
     */
    public set witnesses(newWitnesses: W) {
      this._witnesses = newWitnesses;
      this.contract = config.contractFactory(this._witnesses);
      this.resetCircuitProxies();
    }

    /**
     * Overrides a specific witness function while keeping others unchanged.
     *
     * @param key - The key of the witness function to override
     * @param fn - The new implementation for the witness function
     */
    public overrideWitness<K extends keyof W>(key: K, fn: W[K]) {
      this.witnesses = {
        ...this._witnesses,
        [key]: fn,
      } as W;
    }

    /**
     * Gets the current witness context with the proper structure for witness function calls.
     *
     * @returns The current witness context that can be passed to witness functions
     */
    public getWitnessContext(): WitnessContext<L, P> {
      const circuitCtx = this.circuitContext;
      return {
        ledger: this.getPublicState(),
        // Runtime-typed `P | undefined`; always set after init (see
        // `AbstractSimulator.getPrivateState`).
        privateState: circuitCtx.callContext.currentPrivateState as P,
        contractAddress: circuitCtx.callContext.currentQueryContext.address,
      };
    }
  };
}
