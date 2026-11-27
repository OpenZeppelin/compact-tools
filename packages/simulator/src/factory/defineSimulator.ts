import type { IMinimalContract } from '../types/Contract.js';
import type { FlatCircuits } from '../types/index.js';
import type { SimulatorOptions } from '../types/Options.js';
import {
  type Composed,
  type PartFactory,
  type Parts,
  partsFactory,
} from './composeParts.js';
import {
  type BackendDeps,
  createSimulator,
  type ReservedFlatName,
  type SimulatorInstance,
} from './createSimulator.js';

/**
 * The exports of a compiled contract module (`contract/index.js`) that
 * {@link defineSimulator} reads. Pass the module namespace:
 * `import * as MockOwnable from '.../MockOwnable/contract/index.js'`.
 */
export interface ContractArtifact {
  Contract: new (witnesses: any) => IMinimalContract;
  ledger: (state: any) => unknown;
  pureCircuits?: object;
}

/** The contract instance type of an artifact. */
export type ArtifactContract<A extends ContractArtifact> = InstanceType<
  A['Contract']
>;

/** The ledger type of an artifact. */
export type ArtifactLedger<A extends ContractArtifact> = ReturnType<
  A['ledger']
>;

/** The constructor arguments of an artifact's contract, context excluded. */
export type ConstructorArgs<A extends ContractArtifact> =
  ArtifactContract<A> extends {
    initialState(context: any, ...args: infer R): any;
  }
    ? R
    : never;

/**
 * Static names a pure circuit never takes: function and `Object.prototype`
 * members, `create`, `_create`, and `then`.
 */
export type ReservedStaticName =
  | keyof CallableFunction
  | ReservedFlatName
  | 'create'
  | '_create';

/** One synchronous static method per pure circuit of the artifact. */
export type PureCircuitStatics<A extends ContractArtifact> = A extends {
  pureCircuits: infer PC;
}
  ? Omit<PC, ReservedStaticName>
  : unknown;

/**
 * A defined simulator instance: the base members, one async method per
 * circuit, then the members `extend` and `prepare` add, which win.
 */
export type DefinedSimulatorInstance<
  A extends ContractArtifact,
  P,
  W,
  X = unknown,
> = SimulatorInstance<
  P,
  ArtifactLedger<A>,
  W,
  ArtifactContract<A>,
  ConstructorArgs<A>
> &
  Omit<
    FlatCircuits<ArtifactContract<A>, P>,
    | keyof SimulatorInstance<
        P,
        ArtifactLedger<A>,
        W,
        ArtifactContract<A>,
        ConstructorArgs<A>
      >
    | ReservedFlatName
    | keyof X
  > &
  X;

/**
 * The private-state members of any simulator instance. Types the `sim` of an
 * `extend` helper written outside the spec, e.g. next to the witnesses.
 */
export type PrivateStateAccess<P> = Pick<
  SimulatorInstance<P, unknown, unknown, IMinimalContract>,
  'getPrivateState' | 'setPrivateState' | 'updatePrivateState'
>;

/** `create`'s positional form: the constructor arguments, then optional options. */
export type PositionalInput<A extends ContractArtifact, P, W> =
  | ConstructorArgs<A>
  | [...ConstructorArgs<A>, SimulatorOptions<P, W>];

/** The class {@link defineSimulator} returns. Extend it to name the type. */
export type DefinedSimulatorClass<
  A extends ContractArtifact,
  P,
  W,
  X,
  I extends readonly unknown[],
> = PureCircuitStatics<A> & {
  /** Deploys a fresh contract and resolves to an instance of the calling class. */
  create<T extends abstract new (...args: any) => any>(
    this: T,
    ...input: I
  ): Promise<InstanceType<T>>;
  /** The tuple form `createSimulator` classes use. */
  _create<T extends abstract new (...args: any) => any>(
    this: T,
    contractArgs?: ConstructorArgs<A>,
    options?: SimulatorOptions<P, W>,
  ): Promise<InstanceType<T>>;
} & (new (
    deps: BackendDeps<P, ArtifactLedger<A>>,
  ) => DefinedSimulatorInstance<A, P, W, X>);

/** What `prepare` returns for one `create` call. */
export interface PreparedCreate<A extends ContractArtifact, P, W, F> {
  /** The contract's constructor arguments. */
  args: Readonly<ConstructorArgs<A>>;
  options?: SimulatorOptions<P, W>;
  /** Own fields set on the new instance, e.g. a wallet the witnesses read. */
  fields?: F;
}

/** The settings {@link defineSimulator} takes besides the artifact. */
export interface SimulatorDefinition<
  A extends ContractArtifact,
  WF extends PartFactory,
  PF extends PartFactory,
  X,
> {
  /**
   * Witness factory, or a list of factories merged into one (module and
   * authenticator parts). Defaults to no witnesses.
   */
  witnesses?: Parts<WF>;
  /**
   * Factory for the private state an instance starts with, or a list of
   * factories merged into one. Defaults to `{}`.
   */
  privateState?: Parts<PF>;
  /**
   * Adds members to every instance, e.g. a `privateState` helper bag. They
   * replace circuit methods of the same name.
   */
  extend?: (sim: DefinedSimulatorInstance<A, Composed<PF>, Composed<WF>>) => X;
  /** The `artifacts/<name>/` directory the live backend deploys. Dry ignores it. */
  artifactName?: string;
  /**
   * The constructor's argument count. Read from the compiled contract when
   * omitted.
   */
  arity?: number;
}

type AnyDefinition = SimulatorDefinition<
  ContractArtifact,
  PartFactory,
  PartFactory,
  object
> & {
  prepare?: (...input: unknown[]) => {
    args: readonly unknown[];
    options?: object;
    fields?: object;
  };
};

type AnySimulatorClass = (new (
  deps: BackendDeps<unknown, unknown>,
) => object) & {
  _create(args: readonly unknown[], options?: object): Promise<object>;
};

const INITIAL_STATE_ARITY =
  /initialState\s*\(\s*\.\.\.(\w+)\s*\)\s*\{\s*if\s*\(\s*\1\.length\s*!==\s*(\d+)\s*\)/;

/**
 * Reads the constructor arity from the compiled `initialState`, which checks
 * its argument count (context included) before anything else.
 */
function readArity(contract: ContractArtifact['Contract']): number {
  const source = String(contract.prototype?.initialState ?? '');
  const match = INITIAL_STATE_ARITY.exec(source);
  if (!match) {
    throw new Error(
      'defineSimulator: cannot read the constructor arity from the compiled contract; pass `arity`',
    );
  }
  return Number(match[2]) - 1;
}

function splitPositional(
  input: unknown[],
  arity: number,
): { args: unknown[]; options?: object; fields?: object } {
  if (input.length === arity) return { args: input };
  if (input.length === arity + 1) {
    return {
      args: input.slice(0, arity),
      options: (input[arity] ?? {}) as object,
    };
  }
  throw new Error(
    `create: expected ${arity} constructor argument(s) and an optional options object, received ${input.length} argument(s)`,
  );
}

/** Defines each own key of `members` on `target`, like a class field. */
function defineMembers(target: object, members: object): void {
  for (const key of Reflect.ownKeys(members)) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (members as Record<PropertyKey, unknown>)[key],
    });
  }
}

/**
 * Defines a simulator class from a compiled contract module, with no
 * per-circuit code.
 *
 * - Every circuit is an async instance method (see `flatCircuits`).
 * - Every pure circuit is also a synchronous static method.
 * - `create(...constructorArgs, options?)` takes the contract's constructor
 *   arguments positionally. With `prepare`, it takes `prepare`'s parameters.
 * - The live backend sees a full `SimulatorConfig`: identity `contractArgs`,
 *   the witness and private-state factories, `artifactName`.
 *
 * @example
 * class OwnableSimulator extends defineSimulator(MockOwnable, {
 *   witnesses: [OwnableWitnesses, AuthWitnesses],
 *   privateState: [AuthPrivateState.generate],
 *   artifactName: 'MockOwnable',
 * }) {}
 *
 * const sim = await OwnableSimulator.create(owner, true, { privateState });
 * await sim.transferOwnership(newOwner);
 */
export function defineSimulator<
  A extends ContractArtifact,
  WF extends PartFactory = () => object,
  PF extends PartFactory = () => Record<string, never>,
  X = unknown,
  I extends readonly unknown[] = never,
  F = unknown,
>(
  artifact: A,
  definition: SimulatorDefinition<A, WF, PF, X> & {
    /**
     * Replaces the positional form: maps `create`'s arguments to the
     * constructor arguments, the options, and fields for the new instance.
     */
    prepare: (...input: I) => PreparedCreate<A, Composed<PF>, Composed<WF>, F>;
  },
): DefinedSimulatorClass<A, Composed<PF>, Composed<WF>, X & F, I>;
export function defineSimulator<
  A extends ContractArtifact,
  WF extends PartFactory = () => object,
  PF extends PartFactory = () => Record<string, never>,
  X = unknown,
>(
  artifact: A,
  definition?: SimulatorDefinition<A, WF, PF, X>,
): DefinedSimulatorClass<
  A,
  Composed<PF>,
  Composed<WF>,
  X,
  PositionalInput<A, Composed<PF>, Composed<WF>>
>;
export function defineSimulator(
  artifact: ContractArtifact,
  definition: AnyDefinition = {},
): unknown {
  const { extend, prepare } = definition;
  const arity = prepare
    ? 0
    : (definition.arity ?? readArity(artifact.Contract));

  const Base = createSimulator({
    contractFactory: (witnesses) => new artifact.Contract(witnesses),
    defaultPrivateState: partsFactory(
      'private state key',
      definition.privateState,
    ),
    contractArgs: (...args: unknown[]) => args,
    ledgerExtractor: (state) => artifact.ledger(state),
    witnessesFactory: partsFactory('witness', definition.witnesses),
    artifactName: definition.artifactName,
    flatCircuits: true,
  }) as unknown as AnySimulatorClass;

  class DefinedSimulator extends Base {
    constructor(deps: BackendDeps<unknown, unknown>) {
      super(deps);
      if (extend) defineMembers(this, extend(this as never) as object);
    }

    static async create(
      this: AnySimulatorClass,
      ...input: unknown[]
    ): Promise<object> {
      const { args, options, fields } = prepare
        ? prepare(...input)
        : splitPositional(input, arity);
      // biome-ignore lint/complexity/noThisInStatic: keep the caller's `this` so a subclass constructs its own type.
      const sim = await this._create(args, options);
      if (fields) Object.assign(sim, fields);
      return sim;
    }
  }

  for (const [name, circuit] of Object.entries(artifact.pureCircuits ?? {})) {
    if (name in DefinedSimulator || name === 'then') continue;
    Object.defineProperty(DefinedSimulator, name, {
      configurable: true,
      writable: true,
      value: circuit,
    });
  }

  return DefinedSimulator;
}
