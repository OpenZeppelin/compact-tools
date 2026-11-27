/**
 * Type-level guard for `defineSimulator`, on a synthetic artifact shaped like
 * compactc output.
 *
 * Exports nothing and is imported by nothing. The build config excludes
 * `*.type-test.ts` from emit; `yarn types` compiles it.
 */
import type {
  CircuitContext,
  WitnessContext,
} from '@midnight-ntwrk/compact-runtime';
import {
  composePrivateState,
  composeWitnesses,
} from './factory/composeParts.js';
import { createSimulator } from './factory/createSimulator.js';
import {
  defineSimulator,
  type PrivateStateAccess,
} from './factory/defineSimulator.js';

type Ctx = CircuitContext<unknown>;
type Res<R> = Promise<{ result: R; context: Ctx }>;

type Impure = {
  mint: (ctx: Ctx, amount: bigint) => Res<[]>;
  balance: (ctx: Ctx) => Res<bigint>;
};

type Pure = {
  hash: (ctx: Ctx, x: bigint) => Res<bigint>;
  name: (ctx: Ctx) => Res<bigint>;
};

type Ledger = { counter: bigint };

type Witnesses<PS> = {
  wit_count(context: WitnessContext<Ledger, PS>): [PS, bigint];
  wit_secret(context: WitnessContext<Ledger, PS>): [PS, Uint8Array];
};

declare class SyntheticContract<
  PS = any,
  W extends Witnesses<PS> = Witnesses<PS>,
> {
  witnesses: W;
  circuits: Impure & Pure;
  impureCircuits: Impure;
  constructor(witnesses: W);
  initialState(
    ctx: unknown,
    owner: Uint8Array,
    values: bigint[],
  ): Promise<never>;
}

declare const artifact: {
  Contract: typeof SyntheticContract;
  ledger: (state: unknown) => Ledger;
  pureCircuits: { hash(x: bigint): bigint; name(): bigint; then(): bigint };
};

/** A contract without witnesses. */
declare const stateless: {
  Contract: new (witnesses: unknown) => SyntheticContract;
  ledger: (state: unknown) => Ledger;
  pureCircuits: { hash(x: bigint): bigint; name(): bigint };
};

type ModuleState = { count: bigint };
type AuthState = { secret: Uint8Array };

// Parts typed on their own slice, as module and authenticator files write them.
declare const moduleWitnesses: <L>() => {
  wit_count(context: WitnessContext<L, ModuleState>): [ModuleState, bigint];
};
declare const authWitnesses: <L>() => {
  wit_secret(context: WitnessContext<L, AuthState>): [AuthState, Uint8Array];
};
declare const moduleState: () => ModuleState;
declare const authState: () => AuthState;

type BundledState = ModuleState & AuthState;

/** One factory over the whole state. */
declare const bundledWitnesses: <L>() => {
  wit_count(context: WitnessContext<L, BundledState>): [BundledState, bigint];
  wit_secret(
    context: WitnessContext<L, BundledState>,
  ): [BundledState, Uint8Array];
};
declare const bundledState: () => BundledState;

class Guard extends defineSimulator(artifact, {
  witnesses: [moduleWitnesses, authWitnesses],
  privateState: [moduleState, authState],
}) {}

async function _create(): Promise<void> {
  const owner = new Uint8Array(32);
  const sim: Guard = await Guard.create(owner, [1n]);
  await Guard.create(owner, [1n], {
    privateState: { count: 1n, secret: owner },
  });

  // @ts-expect-error a constructor argument is missing.
  await Guard.create(owner);
  // @ts-expect-error wrong constructor argument type.
  await Guard.create(owner, 1n);
  // @ts-expect-error one argument past the options.
  await Guard.create(owner, [1n], {}, {});
  // @ts-expect-error the private state lacks the authenticator's key.
  await Guard.create(owner, [1n], { privateState: { count: 1n } });

  const tuple: Guard = await Guard._create([owner, [1n]]);
  void [sim, tuple];
}

async function _circuits(): Promise<void> {
  const sim = await Guard.create(new Uint8Array(32), [1n]);
  const minted: [] = await sim.mint(1n);
  const hashed: bigint = await sim.hash(1n);
  const chained: [] = await sim.as('OWNER').mint(1n);
  const ledger: Ledger = await sim.getPublicState();

  // @ts-expect-error not a circuit.
  await sim.burn();
  // @ts-expect-error wrong argument type.
  await sim.mint('1');

  void [minted, hashed, chained, ledger];
}

function _statics(): void {
  const hashed: bigint = Guard.hash(1n);
  const className: string = Guard.name;

  // @ts-expect-error `name` stays `Function.name`.
  const circuit: bigint = Guard.name;
  // @ts-expect-error impure circuits are not static.
  Guard.mint(1n);
  // @ts-expect-error `then` never becomes a static.
  Guard.then();

  void [hashed, className, circuit];
}

async function _parts(
  context: WitnessContext<Ledger, ModuleState & AuthState>,
): Promise<void> {
  const sim = await Guard.create(new Uint8Array(32), [1n]);
  const state: ModuleState & AuthState = await sim.getPrivateState();
  // The merged witnesses return the whole state.
  const secret: [ModuleState & AuthState, Uint8Array] =
    sim.witnesses.wit_secret(context);
  const merged = composeWitnesses(moduleWitnesses, authWitnesses)();
  const count: [ModuleState & AuthState, bigint] = merged.wit_count(context);

  // @ts-expect-error no such witness in either part.
  sim.witnesses.wit_other;

  void [state, secret, count];
}

// The contract's witnesses decide what a definition accepts.

defineSimulator(artifact, {
  witnesses: bundledWitnesses,
  privateState: bundledState,
});

defineSimulator(artifact, {
  // @ts-expect-error `wit_secret` is missing.
  witnesses: <L>() => moduleWitnesses<L>(),
  privateState: moduleState,
});

defineSimulator(artifact, {
  // @ts-expect-error `wit_secret` returns a string, the contract a byte array.
  witnesses: <L>() => ({
    ...moduleWitnesses<L>(),
    wit_secret: (
      context: WitnessContext<L, ModuleState & AuthState>,
    ): [ModuleState & AuthState, string] => [context.privateState, ''],
  }),
  privateState: bundledState,
});

defineSimulator(artifact, {
  // @ts-expect-error the witnesses read a private state the factory does not make.
  witnesses: bundledWitnesses,
  privateState: moduleState,
});

defineSimulator(artifact, {
  // @ts-expect-error the authenticator part is missing.
  witnesses: [moduleWitnesses],
  privateState: [moduleState, authState],
});

defineSimulator(artifact, {
  // @ts-expect-error the authenticator part reads a key no private-state part makes.
  witnesses: [moduleWitnesses, authWitnesses],
  privateState: [moduleState],
});

// @ts-expect-error a contract with witnesses needs `witnesses`.
defineSimulator(artifact, { privateState: bundledState });

// A part generic over the merged state, and the parts merged for `createSimulator`.

createSimulator<
  ModuleState & AuthState,
  Ledger,
  Witnesses<ModuleState & AuthState>,
  SyntheticContract<ModuleState & AuthState>,
  [Uint8Array, bigint[]]
>({
  contractFactory: (witnesses) =>
    new SyntheticContract<ModuleState & AuthState>(witnesses),
  defaultPrivateState: composePrivateState(moduleState, authState),
  contractArgs: (owner, values) => [owner, values],
  ledgerExtractor: (state) => artifact.ledger(state),
  witnessesFactory: composeWitnesses(moduleWitnesses, authWitnesses),
});

type Kind = { kind: 'a'; a: bigint } | { kind: 'b'; b: bigint };

const Union = defineSimulator(stateless, {
  privateState: (): Kind => ({ kind: 'a', a: 1n }),
});

async function _union(): Promise<void> {
  const sim = await Union.create(new Uint8Array(32), [1n]);
  // One factory's union stays a union.
  const kind: 'a' | 'b' = (await sim.getPrivateState()).kind;
  void kind;
}

const Extended = defineSimulator(artifact, {
  witnesses: bundledWitnesses,
  privateState: bundledState,
  extend: (sim) => ({
    privateState: {
      injectCount: (count: bigint) => sim.updatePrivateState({ count }),
    },
    hash: (x: bigint): bigint => artifact.pureCircuits.hash(x),
  }),
});

async function _extend(): Promise<void> {
  const sim = await Extended.create(new Uint8Array(32), [1n]);
  const injected: ModuleState = await sim.privateState.injectCount(1n);
  // A member `extend` adds replaces the circuit method's type.
  const hashed: bigint = sim.hash(1n);
  const chained: bigint = sim.as('OWNER').hash(1n);

  // @ts-expect-error `extend` typed the bag.
  await sim.privateState.injectSecret(1n);

  void [injected, hashed, chained];
}

// An inline composed private state with `extend`.
const InlineComposed = defineSimulator(artifact, {
  witnesses: [moduleWitnesses, authWitnesses],
  privateState: composePrivateState(moduleState, authState),
  extend: (sim) => ({
    count: async (): Promise<bigint> => (await sim.getPrivateState()).count,
  }),
});

const Prepared = defineSimulator(artifact, {
  witnesses: bundledWitnesses,
  privateState: bundledState,
  prepare: (input: { owner: Uint8Array; wallet?: string }) => ({
    args: [input.owner, [1n]],
    fields: { wallet: input.wallet ?? 'fresh' },
  }),
});

async function _prepare(): Promise<void> {
  const sim = await Prepared.create({ owner: new Uint8Array(32) });
  const wallet: string = sim.wallet;
  const balance: bigint = await sim.balance();
  const composed = await InlineComposed.create(new Uint8Array(32), [1n]);
  const count: bigint = await composed.count();

  // @ts-expect-error `create` takes `prepare`'s parameters.
  await Prepared.create(new Uint8Array(32), [1n]);
  // @ts-expect-error a class with `prepare` has no tuple form.
  await Prepared._create([new Uint8Array(32), [1n]]);

  void [wallet, balance, count];
}

// @ts-expect-error `args` must match the constructor.
defineSimulator(stateless, {
  prepare: () => ({ args: [new Uint8Array(32)] }),
});

// `prepare` may supply the witnesses; they are checked against the contract.
defineSimulator(artifact, {
  privateState: bundledState,
  prepare: () => ({
    args: [new Uint8Array(32), [1n] as bigint[]] as const,
    options: { witnesses: bundledWitnesses() },
  }),
});

// @ts-expect-error `wit_secret` is missing from the prepared witnesses.
defineSimulator(artifact, {
  privateState: bundledState,
  prepare: () => ({
    args: [new Uint8Array(32), [1n] as bigint[]] as const,
    options: { witnesses: moduleWitnesses() },
  }),
});

// Helpers written outside the spec, as a witnesses file writes them.
const stateHelpers = (sim: PrivateStateAccess<ModuleState>) => ({
  privateState: {
    bump: (count: bigint): Promise<ModuleState> =>
      sim.updatePrivateState({ count }),
  },
});

const ledgerHelpers = <L extends { counter: bigint }>(
  sim: PrivateStateAccess<ModuleState> & { getPublicState(): Promise<L> },
) => ({
  counter: async (): Promise<bigint> => (await sim.getPublicState()).counter,
});

const prepareOwner = (owner: Uint8Array = new Uint8Array(32)) => ({
  args: [owner, [1n] as bigint[]] as const,
  fields: { tag: 'prepared' as const },
});

const OutOfLine = defineSimulator(stateless, {
  privateState: moduleState,
  extend: stateHelpers,
  prepare: prepareOwner,
});

const GenericHelpers = defineSimulator(stateless, {
  privateState: moduleState,
  extend: ledgerHelpers,
});

async function _outOfLine(): Promise<void> {
  const sim = await OutOfLine.create();
  const bumped: ModuleState = await sim.privateState.bump(1n);
  const tag: 'prepared' = sim.tag;
  const generic = await GenericHelpers.create(new Uint8Array(32), [1n]);
  const counter: bigint = await generic.counter();

  // @ts-expect-error a helper typed for another private state.
  defineSimulator(stateless, { privateState: authState, extend: stateHelpers });

  void [bumped, tag, counter];
}

// A subclass cannot redeclare `create`; a custom signature goes in `prepare`.

// @ts-expect-error TS2417, another signature.
class OwnCreate extends Guard {
  static override async create(owner: string): Promise<OwnCreate> {
    return Guard.create(new Uint8Array(32), [BigInt(owner)]) as never;
  }
}

// @ts-expect-error TS2417, even the constructor's own arguments.
class SameCreate extends Guard {
  static override async create(
    owner: Uint8Array,
    values: bigint[],
  ): Promise<SameCreate> {
    return Guard.create(owner, values) as never;
  }
}

// @ts-expect-error TS2417, on a class with `prepare`.
class PreparedOwnCreate extends Prepared {
  static override async create(owner: string): Promise<PreparedOwnCreate> {
    return Prepared.create({
      owner: new Uint8Array(32),
      wallet: owner,
    }) as never;
  }
}

void [OwnCreate, SameCreate, PreparedOwnCreate];
void _create;
void _circuits;
void _statics;
void _parts;
void _union;
void _extend;
void _prepare;
void _outOfLine;
