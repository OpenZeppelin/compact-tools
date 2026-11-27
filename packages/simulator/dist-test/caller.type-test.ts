/**
 * Type-level guard for the published declarations. It imports the package by
 * name, so it compiles against `dist` as a consumer does. `yarn types` builds
 * the package first.
 *
 * Exports nothing and is imported by nothing.
 */
import type {
  CircuitContext,
  WitnessContext,
} from '@midnight-ntwrk/compact-runtime';
import {
  createSimulator,
  defineSimulator,
  type IMinimalContract,
  type SimulatorConfig,
} from '@openzeppelin/compact-simulator';

type State = { count: bigint };
type Ledger = { counter: bigint };

type Ctx = CircuitContext<State>;
type Res<R> = Promise<{ result: R; context: Ctx }>;

type Impure = { mint: (ctx: Ctx, amount: bigint) => Res<[]> };
type Pure = { hash: (ctx: Ctx, x: bigint) => Res<bigint> };

interface Contract extends IMinimalContract {
  circuits: Impure & Pure;
  impureCircuits: Impure;
}

const config = {} as unknown as SimulatorConfig<
  State,
  Ledger,
  unknown,
  Contract,
  readonly []
>;

class Created extends createSimulator({ ...config, flatCircuits: true }) {
  marker(): string {
    return 'created';
  }
}

declare class ArtifactContract {
  witnesses: {
    wit_count(context: WitnessContext<Ledger, State>): [State, bigint];
  };
  circuits: Impure & Pure;
  impureCircuits: Impure;
  constructor(witnesses: ArtifactContract['witnesses']);
  initialState(ctx: unknown): Promise<never>;
}

declare const artifact: {
  Contract: typeof ArtifactContract;
  ledger: (state: unknown) => Ledger;
  pureCircuits: { hash(x: bigint): bigint };
};

class Defined extends defineSimulator(artifact, {
  witnesses: <L>() => ({
    wit_count: ({
      privateState,
    }: WitnessContext<L, State>): [State, bigint] => [
      privateState,
      privateState.count,
    ],
  }),
  privateState: (): State => ({ count: 0n }),
}) {}

async function _created(sim: Created): Promise<void> {
  await sim.as('A').mint(1n);
  const chained: Created = sim.as('A').setPersistentCaller('B').resetCaller();
  chained.marker();

  // @ts-expect-error wrong argument type after `as()`.
  await sim.as('A').mint('x');
  // @ts-expect-error wrong argument type after `setPersistentCaller()`.
  await sim.setPersistentCaller('A').mint('x');
  // @ts-expect-error wrong argument type after `resetCaller()`.
  await sim.resetCaller().mint('x');
  // @ts-expect-error not a circuit.
  await sim.as('A').burn();
  // @ts-expect-error wrong argument type through `circuits` after `as()`.
  await sim.as('A').circuits.impure.mint('x');
}

async function _defined(sim: Defined): Promise<void> {
  const same: Defined = sim.as('A');
  await same.mint(1n);
  const hashed: bigint = await sim.as('A').hash(2n);

  // @ts-expect-error wrong argument type after `as()`.
  await sim.as('A').mint('x');
  // @ts-expect-error `hash` resolves to a bigint, not a string.
  const _wrong: string = await sim.as('A').hash(hashed);
}
