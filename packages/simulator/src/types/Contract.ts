import type {
  ContractState,
  EncodedZswapLocalState,
} from '@midnight-ntwrk/compact-runtime';

/**
 * The state a compiled contract's constructor returns.
 *
 * @template P - Private state type.
 */
export interface InitialStateResult<P = any> {
  /** The contract's private state after initialization */
  currentPrivateState: P;
  /** The contract's on-chain state after initialization */
  currentContractState: ContractState;
  /** The Zswap local state for transaction context */
  currentZswapLocalState: EncodedZswapLocalState;
}

/**
 * Minimal interface representing the expected structure of generated Compact contract artifacts.
 *
 * This interface defines the bare minimum properties and methods that the simulator
 * framework expects from any generated contract, allowing type-safe interaction
 * with contracts while acknowledging that the generated artifacts don't provide
 * comprehensive TypeScript types.
 */
export interface IMinimalContract {
  /**
   * Contract initialization method that sets up initial state. Async since
   * compact-runtime 0.18; the union keeps 0.16-era artifacts assignable.
   *
   * @param ctx - Constructor context containing initial private state and coin public key
   * @param args - Additional arguments passed to the contract constructor
   * @returns The initialized contract states, or a promise of them
   */
  initialState: (
    ctx: any,
    ...args: any[]
  ) => InitialStateResult | Promise<InitialStateResult>;

  /**
   * Pure circuit functions that don't modify contract state.
   * These are read-only operations that can be called without changing the blockchain state.
   */
  circuits: Record<PropertyKey, (...args: any[]) => any>;

  /**
   * Impure circuit functions that can modify contract state.
   * These operations may change the contract's state and require transaction context.
   */
  impureCircuits: Record<PropertyKey, (...args: any[]) => any>;
}
