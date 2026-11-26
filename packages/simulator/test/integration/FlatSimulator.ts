import {
  createSimulator,
  type SimulatorConfig,
  type SimulatorOptions,
} from '../../src/index.js';
import {
  Contract as FlatContract,
  ledger,
} from '../fixtures/artifacts/Flat/contract/index.js';
import {
  FlatPrivateState,
  FlatWitnesses,
} from '../fixtures/sample-contracts/witnesses/FlatWitnesses.js';

type FlatLedger = ReturnType<typeof ledger>;
export type FlatWitnessSet = ReturnType<typeof FlatWitnesses>;
type FlatOptions = SimulatorOptions<FlatPrivateState, FlatWitnessSet>;

const config: SimulatorConfig<
  FlatPrivateState,
  FlatLedger,
  FlatWitnessSet,
  FlatContract<FlatPrivateState>
> = {
  contractFactory: (witnesses) => new FlatContract<FlatPrivateState>(witnesses),
  defaultPrivateState: () => FlatPrivateState.generate(),
  contractArgs: () => [],
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => FlatWitnesses<FlatLedger>(),
};

/** The base class with typed flat methods, used without a subclass. */
export const FlatBase = createSimulator({ ...config, flatCircuits: true });

/** A typed flat subclass whose `labelled` field replaces the circuit's method. */
export class FlatSimulator extends FlatBase {
  static async create(options: FlatOptions = {}): Promise<FlatSimulator> {
    // biome-ignore lint/complexity/noThisInStatic: super._create must keep the subclass `this`
    return super._create([], options) as Promise<FlatSimulator>;
  }

  public readonly labelled = async (): Promise<bigint> => 100n;
}

/**
 * Without `flatCircuits: true`. A prototype method named like a circuit fails
 * TS2425 on a typed flat class, so the method case lives here.
 */
export class UntypedFlatSimulator extends createSimulator(config) {
  static async create(
    options: FlatOptions = {},
  ): Promise<UntypedFlatSimulator> {
    // biome-ignore lint/complexity/noThisInStatic: super._create must keep the subclass `this`
    return super._create([], options) as Promise<UntypedFlatSimulator>;
  }

  public described(): Promise<bigint> {
    return Promise.resolve(200n);
  }
}
