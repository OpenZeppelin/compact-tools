import { createSimulator, type SimulatorOptions } from '../../src/index';
import {
  ledger,
  Contract as SimpleContract,
} from '../fixtures/artifacts/Simple/contract/index.js';
import {
  SimplePrivateState,
  SimpleWitnesses,
} from '../fixtures/sample-contracts/witnesses/SimpleWitnesses';

/**
 * Base simulator
 */
const SimpleSimulatorBase = createSimulator<
  SimplePrivateState,
  ReturnType<typeof ledger>,
  ReturnType<typeof SimpleWitnesses>,
  SimpleContract<SimplePrivateState>
>({
  contractFactory: (witnesses) =>
    new SimpleContract<SimplePrivateState>(witnesses),
  defaultPrivateState: () => SimplePrivateState,
  contractArgs: () => [],
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => SimpleWitnesses(),
});

/**
 * Simple Simulator
 */
export class SimpleSimulator extends SimpleSimulatorBase {
  static async create(
    options: SimulatorOptions<
      SimplePrivateState,
      ReturnType<typeof SimpleWitnesses>
    > = {},
  ): Promise<SimpleSimulator> {
    // biome-ignore lint/complexity/noThisInStatic: super._create must keep the subclass `this`
    return super._create([], options) as Promise<SimpleSimulator>;
  }

  public setVal(n: bigint): Promise<[]> {
    return this.circuits.impure.setVal(n);
  }

  public getVal(): Promise<bigint> {
    return this.circuits.impure.getVal();
  }
}
