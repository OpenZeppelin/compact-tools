import { createSimulator, type SimulatorOptions } from '../../src/index';
import {
  ledger,
  Contract as WitnessContract,
} from '../fixtures/artifacts/Witness/contract/index.js';
import {
  WitnessPrivateState,
  WitnessWitnesses,
} from '../fixtures/sample-contracts/witnesses/WitnessWitnesses';

/** Type constructor args */
type WitnessArgs = readonly [];

/** Concrete ledger type extracted from the generated artifact */
type WitnessLedger = ReturnType<typeof ledger>;

/**
 * Base simulator
 */
const WitnessSimulatorBase = createSimulator<
  WitnessPrivateState,
  ReturnType<typeof ledger>,
  ReturnType<typeof WitnessWitnesses>,
  WitnessContract<WitnessPrivateState>,
  WitnessArgs
>({
  contractFactory: (witnesses) =>
    new WitnessContract<WitnessPrivateState>(witnesses),
  defaultPrivateState: () => WitnessPrivateState.generate(),
  contractArgs: () => {
    return [];
  },
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => WitnessWitnesses<WitnessLedger>(),
});

/**
 * Witness Simulator
 */
export class WitnessSimulator extends WitnessSimulatorBase {
  static async create(
    options: SimulatorOptions<
      WitnessPrivateState,
      ReturnType<typeof WitnessWitnesses>
    > = {},
  ): Promise<WitnessSimulator> {
    // biome-ignore lint/complexity/noThisInStatic: super.create must keep the subclass `this`
    return super.create([], options) as Promise<WitnessSimulator>;
  }

  public setBytes(): Promise<[]> {
    return this.circuits.impure.setBytes();
  }

  public setField(arg: bigint): Promise<[]> {
    return this.circuits.impure.setField(arg);
  }

  public setUint(arg1: bigint, arg2: bigint): Promise<[]> {
    return this.circuits.impure.setUint(arg1, arg2);
  }

  public readonly privateState = {
    injectSecretBytes: async (
      newBytes: Buffer<ArrayBufferLike>,
    ): Promise<WitnessPrivateState> => {
      const currentState = await this.getPrivateState();
      const updatedState = { ...currentState, secretBytes: newBytes };
      this.setPrivateState(updatedState);
      return updatedState;
    },
    injectSecretField: async (
      newField: bigint,
    ): Promise<WitnessPrivateState> => {
      const currentState = await this.getPrivateState();
      const updatedState = { ...currentState, secretField: newField };
      this.setPrivateState(updatedState);
      return updatedState;
    },
    injectSecretUint: async (newUint: bigint): Promise<WitnessPrivateState> => {
      const currentState = await this.getPrivateState();
      const updatedState = { ...currentState, secretUint: newUint };
      this.setPrivateState(updatedState);
      return updatedState;
    },
  };
}
