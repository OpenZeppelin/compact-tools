import { type BaseSimulatorOptions, createSimulator } from '../../src/index';
import {
  UTXOPrivateState,
  UTXOWitnesses,
} from '../fixtures/sample-contracts/witnesses/UTXOWitnesses';
import {
  type CoinInfo,
  type ContractAddress,
  type Either,
  ledger,
  type QualifiedCoinInfo,
  Contract as UTXOContract,
  type ZswapCoinPublicKey,
} from '../fixtures/test-artifacts/UTXO/contract/index.cjs';

/**
 * Base simulator
 */
const UTXOSimulatorBase = createSimulator({
  contractFactory: (witnesses) => new UTXOContract<UTXOPrivateState>(witnesses),
  defaultPrivateState: () => UTXOPrivateState,
  contractArgs: () => [],
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => UTXOWitnesses(),
});

/**
 * UTXO Simulator
 */
export class UTXOSimulator extends UTXOSimulatorBase {
  constructor(
    options: BaseSimulatorOptions<
      UTXOPrivateState,
      ReturnType<typeof UTXOWitnesses>
    > = {},
  ) {
    super([], options);
  }

  public mint(
    domain: Uint8Array,
    amount: bigint,
    nonce: Uint8Array,
    recipient: Either<ZswapCoinPublicKey, ContractAddress>,
  ) {
    this.circuits.impure.mint(domain, amount, nonce, recipient);
  }

  public sendToken(
    input: QualifiedCoinInfo,
    recipient: Either<ZswapCoinPublicKey, ContractAddress>,
    value: bigint,
  ) {
    return this.circuits.impure.sendToken(input, recipient, value);
  }

  public receiveToken(coin: CoinInfo) {
    return this.circuits.impure.receiveToken(coin);
  }

  public receiveTokenSendChange(coin: CoinInfo, change: bigint) {
    return this.circuits.impure.receiveTokenSendChange(coin, change);
  }
}
