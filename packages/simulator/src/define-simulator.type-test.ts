/**
 * Type-level guard for `defineSimulator`, on a synthetic artifact.
 *
 * Exports nothing and is imported by nothing. The build config excludes
 * `*.type-test.ts` from emit; `yarn types` compiles it.
 */
import type { CircuitContext } from '@midnight-ntwrk/compact-runtime';
import { composeWitnesses } from './factory/composeParts.js';
import {
  defineSimulator,
  type PrivateStateAccess,
} from './factory/defineSimulator.js';
import type { IMinimalContract } from './types/Contract.js';

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

interface SyntheticContract extends IMinimalContract {
  circuits: Impure & Pure;
  impureCircuits: Impure;
  initialState(
    ctx: unknown,
    owner: Uint8Array,
    values: bigint[],
  ): Promise<never>;
}

declare const artifact: {
  Contract: new (witnesses: unknown) => SyntheticContract;
  ledger: (state: unknown) => { counter: bigint };
  pureCircuits: { hash(x: bigint): bigint; name(): bigint };
};

type ModuleState = { count: bigint };
type AuthState = { secret: Uint8Array };

declare const moduleWitnesses: <L>() => {
  wit_count(context: L): [ModuleState, bigint];
};
declare const authWitnesses: <L>() => {
  wit_secret(context: L): [AuthState, Uint8Array];
};
declare const moduleState: () => ModuleState;
declare const authState: () => AuthState;

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
  const ledger: { counter: bigint } = await sim.getPublicState();

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

  void [hashed, className, circuit];
}

async function _parts(): Promise<void> {
  const sim = await Guard.create(new Uint8Array(32), [1n]);
  const state: ModuleState & AuthState = await sim.getPrivateState();
  const secret: [AuthState, Uint8Array] = sim.witnesses.wit_secret(0);
  const merged = composeWitnesses(moduleWitnesses, authWitnesses)();
  const count: [ModuleState, bigint] = merged.wit_count(0);

  // @ts-expect-error no such witness in either part.
  sim.witnesses.wit_other;

  void [state, secret, count];
}

const Extended = defineSimulator(artifact, {
  privateState: moduleState,
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

const Prepared = defineSimulator(artifact, {
  prepare: (input: { owner: Uint8Array; wallet?: string }) => ({
    args: [input.owner, [1n]],
    fields: { wallet: input.wallet ?? 'fresh' },
  }),
});

async function _prepare(): Promise<void> {
  const sim = await Prepared.create({ owner: new Uint8Array(32) });
  const wallet: string = sim.wallet;
  const balance: bigint = await sim.balance();

  // @ts-expect-error `create` takes `prepare`'s parameters.
  await Prepared.create(new Uint8Array(32), [1n]);

  void [wallet, balance];
}

// @ts-expect-error `args` must match the constructor.
defineSimulator(artifact, { prepare: () => ({ args: [new Uint8Array(32)] }) });

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

const OutOfLine = defineSimulator(artifact, {
  privateState: moduleState,
  extend: stateHelpers,
  prepare: prepareOwner,
});

const GenericHelpers = defineSimulator(artifact, {
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
  defineSimulator(artifact, { privateState: authState, extend: stateHelpers });

  void [bumped, tag, counter];
}

void _create;
void _circuits;
void _statics;
void _parts;
void _extend;
void _prepare;
void _outOfLine;
