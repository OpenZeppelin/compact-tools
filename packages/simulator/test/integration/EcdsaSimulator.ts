import { createSimulator, type SimulatorOptions } from '../../src/index.js';
import {
  Contract as EcdsaContract,
  ledger,
  type Secp256k1EcdsaSignature,
  type Secp256k1Point,
} from '../fixtures/artifacts/Ecdsa/contract/index.js';
import {
  EcdsaPrivateState,
  EcdsaWitnesses,
} from '../fixtures/sample-contracts/witnesses/EcdsaWitnesses.js';

export type { Secp256k1EcdsaSignature, Secp256k1Point };

/**
 * Base simulator
 */
const EcdsaSimulatorBase = createSimulator<
  EcdsaPrivateState,
  ReturnType<typeof ledger>,
  ReturnType<typeof EcdsaWitnesses>,
  EcdsaContract<EcdsaPrivateState>
>({
  contractFactory: (witnesses) =>
    new EcdsaContract<EcdsaPrivateState>(witnesses),
  defaultPrivateState: () => EcdsaPrivateState,
  contractArgs: () => [],
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => EcdsaWitnesses(),
});

/**
 * Ecdsa Simulator
 */
export class EcdsaSimulator extends EcdsaSimulatorBase {
  static async create(
    options: SimulatorOptions<
      EcdsaPrivateState,
      ReturnType<typeof EcdsaWitnesses>
    > = {},
  ): Promise<EcdsaSimulator> {
    // biome-ignore lint/complexity/noThisInStatic: super.create must keep the subclass `this`
    return super.create([], options) as Promise<EcdsaSimulator>;
  }

  /** Pure: verify an Ethereum-style ECDSA signature (no state change). */
  public verifyEthereum(
    msg: Uint8Array,
    sig: Secp256k1EcdsaSignature,
    pk: Secp256k1Point,
  ): Promise<boolean> {
    return this.circuits.pure.verifyEthereum(msg, sig, pk);
  }

  /** Impure: verify and record the outcome on-ledger. */
  public verifyAndStore(
    msg: Uint8Array,
    sig: Secp256k1EcdsaSignature,
    pk: Secp256k1Point,
  ): Promise<boolean> {
    return this.circuits.impure.verifyAndStore(msg, sig, pk);
  }
}
