import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
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
  SIMULATOR_FIELDS,
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

type ContractWitnesses<A extends ContractArtifact> = ConstructorParameters<
  A['Contract']
>[0];

/**
 * The witness set an artifact's contract takes, with the private state `P`.
 * Each witness reads `P` and returns the whole of it.
 */
export type ArtifactWitnesses<A extends ContractArtifact, P> = {
  [K in keyof ContractWitnesses<A>]: ContractWitnesses<A>[K] extends (
    context: WitnessContext<infer L, any>,
    ...args: infer Args
  ) => [any, infer R]
    ? (context: WitnessContext<L, P>, ...args: Args) => [P, R]
    : ContractWitnesses<A>[K];
};

/** What one part of a merged witness set may define: it returns its own slice of `P`. */
type ArtifactWitnessPart<A extends ContractArtifact, P> = {
  [K in keyof ContractWitnesses<A>]?: ContractWitnesses<A>[K] extends (
    context: WitnessContext<infer L, any>,
    ...args: infer Args
  ) => [any, infer R]
    ? (context: WitnessContext<L, P>, ...args: Args) => [Partial<P>, R]
    : ContractWitnesses<A>[K];
};

/**
 * The witness names a list of factories surely supplies: at each position, the
 * names every factory that position can hold returns.
 */
type ListedWitnessNames<L extends readonly PartFactory[]> = {
  [K in keyof L]: [L[K]] extends [PartFactory<infer R>] ? keyof R : never;
}[number];

/**
 * Witness names the contract declares that the list `L` does not surely
 * supply. For a union of lists, the names any one of them lacks.
 */
type MissingListedWitnesses<
  A extends ContractArtifact,
  L extends readonly PartFactory[],
> = string extends keyof ContractWitnesses<A>
  ? never
  : L extends unknown
    ? Exclude<keyof ContractWitnesses<A>, ListedWitnessNames<L>>
    : never;

/** The private state a definition's `privateState` yields. */
export type DefinedPrivateState<PS> = PS extends readonly (infer F extends
  PartFactory)[]
  ? Composed<F>
  : PS extends PartFactory
    ? ReturnType<PS>
    : Record<string, never>;

/**
 * The witness type of a defined simulator: a single factory's own type,
 * otherwise the contract's witness set with private state `P`.
 */
export type DefinedWitnesses<
  A extends ContractArtifact,
  WS,
  P,
> = WS extends PartFactory ? ReturnType<WS> : ArtifactWitnesses<A, P>;

/** What a definition's `witnesses` must be for the contract and `P`. */
type WitnessesFor<A extends ContractArtifact, WS, P> = [WS] extends [
  readonly PartFactory[],
]
  ? readonly PartFactory<ArtifactWitnessPart<A, P>>[] &
      (number extends WS['length']
        ? {
            readonly notATuple: 'list the witness factories in an array literal or a tuple';
          }
        : [MissingListedWitnesses<A, WS>] extends [never]
          ? unknown
          : { readonly missingWitnesses: MissingListedWitnesses<A, WS> })
  : PartFactory<ArtifactWitnesses<A, P>>;

/** Whether a definition's `witnesses` fit the contract and `P`. */
type WitnessesFit<A extends ContractArtifact, WS, P> = [WS] extends [undefined]
  ? true
  : WS extends readonly (infer F extends PartFactory)[]
    ? number extends WS['length']
      ? false
      : [ReturnType<F>] extends [ArtifactWitnessPart<A, P>]
        ? [MissingListedWitnesses<A, WS>] extends [never]
          ? true
          : false
        : false
    : WS extends PartFactory
      ? [ReturnType<WS>] extends [ArtifactWitnesses<A, P>]
        ? true
        : false
      : false;

/**
 * Checks a definition against the contract: on a mismatch, `witnesses` must
 * have the type the contract expects, which names the mismatch. Deferred, so
 * it never steers inference.
 */
type DefinitionCheck<A extends ContractArtifact, WS, PS> = NoInfer<
  (WitnessesFit<A, WS, DefinedPrivateState<PS>> extends true
    ? unknown
    : { witnesses: WitnessesFor<A, WS, DefinedPrivateState<PS>> }) &
    ([PS] extends [Parts | undefined] ? unknown : { privateState: Parts })
>;

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
  | [...ConstructorArgs<A>, SimulatorOptions<P, W> | undefined];

/** The class a definition with `prepare` returns. Extend it to name the type. */
export type PreparedSimulatorClass<
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
} & (new (
    deps: BackendDeps<P, ArtifactLedger<A>>,
  ) => DefinedSimulatorInstance<A, P, W, X>);

/** The class {@link defineSimulator} returns. Extend it to name the type. */
export type DefinedSimulatorClass<
  A extends ContractArtifact,
  P,
  W,
  X,
  I extends readonly unknown[],
> = PreparedSimulatorClass<A, P, W, X, I> & {
  /** The tuple form `createSimulator` classes use. */
  _create<T extends abstract new (...args: any) => any>(
    this: T,
    contractArgs?: ConstructorArgs<A>,
    options?: SimulatorOptions<P, W>,
  ): Promise<InstanceType<T>>;
};

/** What `prepare` returns for one `create` call. */
export interface PreparedCreate<A extends ContractArtifact, P, W, F> {
  /** The contract's constructor arguments. */
  args: Readonly<ConstructorArgs<A>>;
  options?: SimulatorOptions<P, W>;
  /** Own fields set on the new instance, e.g. a wallet the witnesses read. */
  fields?: F;
}

/** The settings {@link defineSimulator} takes besides the artifact. */
export interface SimulatorDefinition<A extends ContractArtifact, WS, PS, X> {
  /**
   * Witness factory, or a list of factories merged into one (module and
   * authenticator parts). Checked against the contract's witnesses.
   */
  witnesses?: WS;
  /**
   * Factory for the private state an instance starts with, or a list of
   * factories merged into one. Defaults to `{}`.
   */
  privateState?: PS;
  /**
   * Adds members to every instance, e.g. a `privateState` helper bag. They
   * replace circuit methods of the same name. A function that replaces a
   * circuit spends the `as()` caller like the circuit; other members leave it
   * to the next circuit call, like subclass methods.
   */
  extend?: (
    sim: DefinedSimulatorInstance<
      A,
      DefinedPrivateState<PS>,
      DefinedWitnesses<A, WS, DefinedPrivateState<PS>>
    >,
  ) => X;
  /** The `artifacts/<name>/` directory the live backend deploys. Dry ignores it. */
  artifactName?: string;
  /**
   * The constructor's argument count. Read from the compiled contract when
   * omitted.
   */
  arity?: number;
}

/** Whether the contract declares witnesses. */
type DeclaresWitnesses<A extends ContractArtifact> =
  string extends keyof ContractWitnesses<A>
    ? false
    : [keyof ContractWitnesses<A>] extends [never]
      ? false
      : true;

/**
 * The definition of a class without `prepare`. A contract with witnesses needs
 * one, with `witnesses` set.
 */
type PositionalDefinition<
  A extends ContractArtifact,
  WS,
  PS,
  X,
> = SimulatorDefinition<A, WS, PS, X> &
  DefinitionCheck<A, WS, PS> &
  (DeclaresWitnesses<A> extends true ? { witnesses: object } : unknown);

/**
 * The definition of a class with `prepare`. For a contract with witnesses,
 * `Source` names what supplies them: the definition's `witnesses`, set to an
 * object, or the `options` that `prepare` returns.
 */
type PreparedDefinition<
  A extends ContractArtifact,
  WS,
  PS,
  X,
  I extends readonly unknown[],
  F,
  Source extends 'definition' | 'prepare',
> = SimulatorDefinition<A, WS, PS, X> &
  DefinitionCheck<A, WS, PS> &
  (Source extends 'definition' ? { witnesses: object } : unknown) & {
    /**
     * Replaces the positional form: maps `create`'s arguments to the
     * constructor arguments, the options, and fields for the new instance.
     */
    prepare: (...input: I) => PreparedCreate<
      A,
      DefinedPrivateState<PS>,
      DefinedWitnesses<A, WS, DefinedPrivateState<PS>>,
      F
    > &
      (Source extends 'prepare'
        ? DeclaresWitnesses<A> extends true
          ? {
              options: {
                witnesses: DefinedWitnesses<A, WS, DefinedPrivateState<PS>>;
              };
            }
          : unknown
        : unknown);
  };

type AnyDefinition = SimulatorDefinition<
  ContractArtifact,
  Parts | undefined,
  Parts | undefined,
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

/** A plain object or `undefined`, e.g. not a bigint, an array or a byte array. */
const isOptions = (value: unknown): value is object | undefined =>
  value === undefined ||
  Object.prototype.toString.call(value) === '[object Object]';

function splitPositional(
  input: unknown[],
  arity: number,
): { args: unknown[]; options?: object; fields?: object } {
  if (input.length === arity) return { args: input };
  if (input.length === arity + 1) {
    const options = input[arity];
    if (!isOptions(options)) {
      throw new Error(
        `create: argument ${arity + 1} must be an options object, received ${Object.prototype.toString.call(options).slice(8, -1)}`,
      );
    }
    return { args: input.slice(0, arity), options };
  }
  throw new Error(
    `create: expected ${arity} constructor argument(s) and an optional options object, received ${input.length} argument(s)`,
  );
}

/** Calls `fn`, then clears a caller `as()` set and the call did not use. */
function consumingCaller(
  fn: (...args: unknown[]) => unknown,
  consume: () => void,
): (...args: unknown[]) => unknown {
  return function (this: unknown, ...args: unknown[]) {
    let result: unknown;
    try {
      result = fn.apply(this, args);
    } catch (error) {
      consume();
      throw error;
    }
    if (typeof (result as PromiseLike<unknown> | null)?.then === 'function') {
      return Promise.resolve(result).finally(consume);
    }
    consume();
    return result;
  };
}

/**
 * Defines each own member of `members` on `target`, like a class field.
 * Accessors stay accessors; `wrap` maps data values by key.
 */
function defineMembers(
  target: object,
  members: object,
  wrap: (key: PropertyKey, value: unknown) => unknown = (_key, value) => value,
): void {
  const descriptors = Object.getOwnPropertyDescriptors(members);
  for (const key of Reflect.ownKeys(descriptors)) {
    const { value, get, set, enumerable } = descriptors[key as string];
    Object.defineProperty(
      target,
      key,
      get || set
        ? { configurable: true, enumerable, get, set }
        : {
            configurable: true,
            enumerable: true,
            writable: true,
            value: wrap(key, value),
          },
    );
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
 * - `witnesses` are checked against the contract's witnesses, with the private
 *   state `privateState` yields.
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
  const WS = undefined,
  PS = undefined,
  X = unknown,
  I extends readonly unknown[] = never,
  F = unknown,
>(
  artifact: A,
  definition: PreparedDefinition<A, WS, PS, X, I, F, 'definition'>,
): PreparedSimulatorClass<
  A,
  DefinedPrivateState<PS>,
  DefinedWitnesses<A, WS, DefinedPrivateState<PS>>,
  X & F,
  I
>;
export function defineSimulator<
  A extends ContractArtifact,
  const WS = undefined,
  PS = undefined,
  X = unknown,
  I extends readonly unknown[] = never,
  F = unknown,
>(
  artifact: A,
  definition: PreparedDefinition<A, WS, PS, X, I, F, 'prepare'>,
): PreparedSimulatorClass<
  A,
  DefinedPrivateState<PS>,
  DefinedWitnesses<A, WS, DefinedPrivateState<PS>>,
  X & F,
  I
>;
export function defineSimulator<
  A extends ContractArtifact,
  const WS = undefined,
  PS = undefined,
  X = unknown,
>(
  artifact: A,
  ...definition: DeclaresWitnesses<A> extends true
    ? [definition: PositionalDefinition<A, WS, PS, X>]
    : [definition?: PositionalDefinition<A, WS, PS, X>]
): DefinedSimulatorClass<
  A,
  DefinedPrivateState<PS>,
  DefinedWitnesses<A, WS, DefinedPrivateState<PS>>,
  X,
  PositionalInput<
    A,
    DefinedPrivateState<PS>,
    DefinedWitnesses<A, WS, DefinedPrivateState<PS>>
  >
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

  const assertNotReserved = (source: string, members: object): void => {
    for (const key of Reflect.ownKeys(members)) {
      if (
        key === 'then' ||
        key in Base.prototype ||
        (SIMULATOR_FIELDS as readonly PropertyKey[]).includes(key)
      ) {
        throw new Error(
          `defineSimulator: ${source} cannot define "${String(key)}", a simulator member name`,
        );
      }
    }
  };

  class DefinedSimulator extends Base {
    constructor(deps: BackendDeps<unknown, unknown>) {
      super(deps);
      if (!extend) return;
      const members = extend(this as never) as object;
      assertNotReserved('extend', members);
      // A member that replaces a circuit spends the `as()` caller like the
      // circuit. Other members behave like subclass methods.
      const circuitNames = new Set([...deps.pureNames, ...deps.impureNames]);
      const consume = () => deps.backend.consumeSingleCaller();
      defineMembers(this, members, (key, value) =>
        typeof value === 'function' && circuitNames.has(key as string)
          ? consumingCaller(value as (...args: unknown[]) => unknown, consume)
          : value,
      );
    }

    static async create(
      this: AnySimulatorClass,
      ...input: unknown[]
    ): Promise<object> {
      const { args, options, fields } = prepare
        ? prepare(...input)
        : splitPositional(input, arity);
      if (fields) assertNotReserved('prepare `fields`', fields);
      // biome-ignore lint/complexity/noThisInStatic: keep the caller's `this` so a subclass constructs its own type.
      const sim = await Base._create.call(this, args, options);
      if (fields) defineMembers(sim, fields);
      return sim;
    }
  }

  if (prepare) {
    Object.defineProperty(DefinedSimulator, '_create', {
      configurable: true,
      writable: true,
      value: () =>
        Promise.reject(
          new Error(
            'defineSimulator: a simulator defined with `prepare` has no `_create`; call `create`',
          ),
        ),
    });
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
