/**
 * Type-level guard for `flatCircuits: true`, on a synthetic contract type.
 *
 * Exports nothing and is imported by nothing. The build config excludes
 * `*.type-test.ts` from emit; `yarn types` compiles it.
 */
import type { CircuitContext } from '@midnight-ntwrk/compact-runtime';
import {
  createSimulator,
  type ReservedFlatName,
} from './factory/createSimulator.js';
import type { SimulatorConfig } from './factory/SimulatorConfig.js';
import type { IMinimalContract } from './types/Contract.js';

type FlatPrivateState = { readonly secret: bigint };
type FlatLedger = { readonly counter: bigint };
type FlatArgs = readonly [a: number, b: string];

type Ctx = CircuitContext<FlatPrivateState>;
type Res<R> = Promise<{ result: R; context: Ctx }>;

type Impure = {
  mint: (ctx: Ctx, amount: bigint) => Res<[]>;
  balance: (ctx: Ctx) => Res<bigint>;
  getPublicState: (ctx: Ctx) => Res<bigint>;
  then: (ctx: Ctx) => Res<[]>;
};

type Pure = {
  hash: (ctx: Ctx, x: bigint) => Res<bigint>;
  toString: (ctx: Ctx) => Res<bigint>;
};

interface FlatContract extends IMinimalContract {
  circuits: Impure & Pure;
  impureCircuits: Impure;
}

const config = {} as unknown as SimulatorConfig<
  FlatPrivateState,
  FlatLedger,
  unknown,
  FlatContract,
  FlatArgs
>;

const FlatBase = createSimulator({ ...config, flatCircuits: true });
const PlainBase = createSimulator(config);

class FlatGuard extends FlatBase {
  static async create(a: number, b: string, options = {}): Promise<FlatGuard> {
    // biome-ignore lint/complexity/noThisInStatic: super._create must keep the subclass `this`
    return super._create([a, b], options) as Promise<FlatGuard>;
  }

  static async _argCheck(): Promise<unknown> {
    // @ts-expect-error a 1-element tuple must not satisfy `[number, string]`.
    return FlatGuard._create([1], {});
  }

  public marker(): string {
    return 'flat';
  }
}

class FlatBare extends FlatBase {}

// Explicit type arguments and inline callbacks, as existing subclasses write them.
class FlatExplicit extends createSimulator<
  FlatPrivateState,
  FlatLedger,
  unknown,
  FlatContract,
  FlatArgs
>({
  contractFactory: () => ({}) as FlatContract,
  defaultPrivateState: () => ({ secret: 0n }),
  contractArgs: (a, b) => [a, b],
  ledgerExtractor: () => ({ counter: 0n }),
  witnessesFactory: () => ({}),
  flatCircuits: true,
}) {}

async function _flatCalls(): Promise<void> {
  const sim = await FlatGuard.create(1, 'x');
  const minted: [] = await sim.mint(1n);
  const balance: bigint = await sim.balance();
  const hash: bigint = await sim.hash(1n);
  const chained: [] = await sim.as('OWNER').mint(1n);
  void sim.marker();

  // @ts-expect-error not a circuit.
  await sim.burn();
  // @ts-expect-error wrong argument type.
  await sim.mint('1');

  void [minted, balance, hash, chained];
}

async function _noOverride(): Promise<void> {
  // A subclass without its own `create` still gets typed circuits.
  const sim = await FlatBare.create([1, 'x']);
  const balance: bigint = await sim.balance();
  void balance;
}

async function _explicitTypeArgs(): Promise<void> {
  const sim = await FlatExplicit.create([1, 'x']);
  const balance: bigint = await sim.balance();
  // @ts-expect-error wrong argument type.
  await sim.mint('1');
  void balance;
}

async function _plainUntyped(): Promise<void> {
  const sim = await PlainBase.create([1, 'x']);
  // @ts-expect-error circuits are typed as methods only with `flatCircuits: true`.
  await sim.mint(1n);
  const viaProxy: [] = await sim.circuits.impure.mint(1n);
  void viaProxy;
}

async function _reservedNames(): Promise<void> {
  const sim = await FlatGuard.create(1, 'x');

  // A circuit named like a base member keeps the member's type.
  const ledger: FlatLedger = await sim.getPublicState();
  // @ts-expect-error `getPublicState` is the base member, not the circuit.
  const shadowed: bigint = await sim.getPublicState();
  const circuit: bigint = await sim.circuits.impure.getPublicState();

  // `Object.prototype` names keep their `Object` type.
  const text: string = sim.toString();
  const pureToString: bigint = await sim.circuits.pure.toString();

  // @ts-expect-error a `then` method would make the instance thenable.
  await sim.then();

  void [ledger, shadowed, circuit, text, pureToString];
}

// Every `Object.prototype` name is reserved, so the flat type omits it.
declare const objectKey: keyof typeof Object.prototype;
const _objectKeysReserved: ReservedFlatName = objectKey;

void _flatCalls;
void _noOverride;
void _explicitTypeArgs;
void _plainUntyped;
void _reservedNames;
void _objectKeysReserved;
