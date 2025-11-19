import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type ZswapCoinPublicKey = { bytes: Uint8Array };

export type ContractAddress = { bytes: Uint8Array };

export type Either<A, B> = { is_left: boolean; left: A; right: B };

export type Maybe<T> = { is_some: boolean; value: T };

export type CoinInfo = { nonce: Uint8Array; color: Uint8Array; value: bigint };

export type QualifiedCoinInfo = { nonce: Uint8Array;
                                  color: Uint8Array;
                                  value: bigint;
                                  mt_index: bigint
                                };

export type Witnesses<T> = {
}

export type ImpureCircuits<T> = {
  mint(context: __compactRuntime.CircuitContext<T>,
       domain_0: Uint8Array,
       amount_0: bigint,
       nonce_0: Uint8Array,
       recipient_0: Either<ZswapCoinPublicKey, ContractAddress>): __compactRuntime.CircuitResults<T, []>;
  sendToken(context: __compactRuntime.CircuitContext<T>,
            input_0: QualifiedCoinInfo,
            recipient_0: Either<ZswapCoinPublicKey, ContractAddress>,
            value_0: bigint): __compactRuntime.CircuitResults<T, []>;
  receiveToken(context: __compactRuntime.CircuitContext<T>, coin_0: CoinInfo): __compactRuntime.CircuitResults<T, []>;
  receiveTokenSendChange(context: __compactRuntime.CircuitContext<T>,
                         coin_0: CoinInfo,
                         change_0: bigint): __compactRuntime.CircuitResults<T, []>;
}

export type PureCircuits = {
}

export type Circuits<T> = {
  mint(context: __compactRuntime.CircuitContext<T>,
       domain_0: Uint8Array,
       amount_0: bigint,
       nonce_0: Uint8Array,
       recipient_0: Either<ZswapCoinPublicKey, ContractAddress>): __compactRuntime.CircuitResults<T, []>;
  sendToken(context: __compactRuntime.CircuitContext<T>,
            input_0: QualifiedCoinInfo,
            recipient_0: Either<ZswapCoinPublicKey, ContractAddress>,
            value_0: bigint): __compactRuntime.CircuitResults<T, []>;
  receiveToken(context: __compactRuntime.CircuitContext<T>, coin_0: CoinInfo): __compactRuntime.CircuitResults<T, []>;
  receiveTokenSendChange(context: __compactRuntime.CircuitContext<T>,
                         coin_0: CoinInfo,
                         change_0: bigint): __compactRuntime.CircuitResults<T, []>;
}

export type Ledger = {
  readonly _coin: QualifiedCoinInfo;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<T, W extends Witnesses<T> = Witnesses<T>> {
  witnesses: W;
  circuits: Circuits<T>;
  impureCircuits: ImpureCircuits<T>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<T>): __compactRuntime.ConstructorResult<T>;
}

export declare function ledger(state: __compactRuntime.StateValue): Ledger;
export declare const pureCircuits: PureCircuits;
