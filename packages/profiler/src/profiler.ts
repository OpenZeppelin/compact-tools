import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChargedState,
  type CircuitContext,
  type CircuitResults,
  type ConstructorContext,
  type ConstructorResult,
  type ContractState,
  createCircuitContext,
  createConstructorContext,
} from '@midnight-ntwrk/compact-runtime';
import {
  ContractOperation,
  LedgerParameters,
  ZswapSecretKeys,
} from '@midnightntwrk/ledger-v9';
import {
  type CostReport,
  costTransaction,
  networkParams,
  type ProfileSource,
} from './commands.ts';
import {
  type Conflict,
  compareVersions,
  type Manifest,
  type ManifestScenario,
  resolvedVersion,
  slugify,
} from './manifest.ts';
import {
  type BuildSettings,
  type ExecutedCall,
  type Measurement,
  measure,
  scenarioTransaction,
} from './transaction.ts';

const LEDGER = '@midnightntwrk/ledger-v9';
const RUNTIME = '@midnight-ntwrk/compact-runtime';

function sha256(label: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(label).digest());
}

/** 2030-01-01T00:00:00Z, in seconds. */
const DEFAULT_TIME = 1_893_456_000;

/** The fixed inputs a profiler uses unless told otherwise. */
export const DEFAULTS = {
  /** sha256 of `compact-profiler:contract-address`. */
  contractAddress: Buffer.from(
    sha256('compact-profiler:contract-address'),
  ).toString('hex'),
  /** The network id written into each transaction, as on a local dev chain. */
  networkId: 'undeployed',
  /** Block time the circuits see, in seconds. */
  time: DEFAULT_TIME,
  /** Intent TTL, one hour after `time`. */
  ttl: new Date((DEFAULT_TIME + 3600) * 1000),
  /** Fixed so its serialized length never varies; the SDK samples one per root call. */
  communicationRandomness:
    '73f9509f0bdc283daa0ed9717b4e3313e61717a03ea1c329247833a3361888bc5c',
} as const;

/** Zswap keys derived from the seed sha256(`compact-profiler:caller`). */
export function defaultCaller(): {
  coinPublicKey: string;
  encryptionPublicKey: string;
} {
  const keys = ZswapSecretKeys.fromSeed(sha256('compact-profiler:caller'));
  return {
    coinPublicKey: keys.coinPublicKey,
    encryptionPublicKey: keys.encryptionPublicKey,
  };
}

/** The parts of a compiled contract instance (`new Contract(witnesses)`) the profiler drives. */
export interface CompiledContract<PS> {
  initialState(
    context: ConstructorContext<PS>,
    ...args: any[]
  ): Promise<ConstructorResult<PS>>;
  impureCircuits: Record<
    string,
    (
      context: CircuitContext<PS>,
      ...args: any[]
    ) => Promise<CircuitResults<PS, any>>
  >;
}

/** `privateState` may be omitted only when `undefined` is a valid private state. */
type PrivateStateOption<PS> = undefined extends PS
  ? { privateState?: PS }
  : { privateState: PS };

export type ProfilerOptions<PS> = BaseOptions<PS> & PrivateStateOption<PS>;

interface BaseOptions<PS> extends ProfileSource {
  /** The manifest's `contract`. */
  name: string;
  contract: CompiledContract<PS>;
  constructorArgs?: readonly unknown[];
  /** Coin public key, hex, that deploys and calls; default {@link defaultCaller}. */
  caller?: string;
  /** Encryption key for a coin sent to `coinPublicKey`; default the default caller's. */
  encryptionPublicKey?: (coinPublicKey: string) => string;
  /** Hex; default {@link DEFAULTS}.contractAddress. */
  contractAddress?: string;
  /** Shipped profile (or `profileFile` entry) whose ledger parameters partition transcripts. */
  network: string;
  /** Receives `manifest.json` and `txs/`. */
  outDir: string;
  /** Extra manifest toolchain entries, such as the compiler version. */
  toolchain?: Readonly<Record<string, string>>;
  networkId?: string;
  /** Block time the circuits see, in seconds. */
  time?: number;
  ttl?: Date;
}

export interface CallOptions {
  /** Coin public key, hex, the call runs as; default the profiler's caller. */
  caller?: string;
}

/**
 * Records the calls of one transaction. Calls run in order, each on the state the previous
 * one left; `await` a call to read its result.
 */
export interface TxBuilder<PS> {
  call<R = unknown>(circuit: string, ...args: unknown[]): Promise<R>;
  callWith<R = unknown>(
    options: CallOptions,
    circuit: string,
    ...args: unknown[]
  ): Promise<R>;
  /** Ledger state after the calls awaited so far; pass it to the artifact's `ledger()`. */
  readonly contractState: ChargedState;
  readonly privateState: PS;
}

export type Build<PS> = (tx: TxBuilder<PS>) => unknown;
export type SizedBuild<PS> = (tx: TxBuilder<PS>, n: number) => unknown;

export interface ScenarioOptions {
  conflict?: Conflict;
  /** Logical operations the transaction performs; default its call count. */
  ops?: number;
}

export interface SeriesOptions {
  sizes: readonly number[];
  conflict?: Conflict;
  ops?: number | ((n: number) => number);
}

export interface SearchOptions {
  /** Networks the transaction must fit, at least one; default the profiler's network. */
  networks?: readonly string[];
  /** Largest size tried. */
  cap?: number;
  conflict?: Conflict;
  ops?: number | ((n: number) => number);
}

export interface SearchResult {
  /** Largest size that fits every network; 0 when size 1 does not. */
  maxN: number;
  /** True when every size up to `cap` fits. */
  capped: boolean;
  /** `<network>: <limit>` that `maxN + 1` exceeds; null when capped. */
  binding: string | null;
  scenarios: ManifestScenario[];
}

interface State<PS> {
  contract: ChargedState;
  private: PS;
}

interface Built {
  calls: number;
  bytes: Uint8Array;
  measurement: Measurement;
}

class Scenario<PS> implements TxBuilder<PS> {
  readonly #runner: Runner<PS>;
  #state: State<PS>;
  readonly #calls: ExecutedCall[] = [];
  #tail: Promise<unknown> = Promise.resolve();

  constructor(runner: Runner<PS>, state: State<PS>) {
    this.#runner = runner;
    this.#state = state;
  }

  get contractState(): ChargedState {
    return this.#state.contract;
  }

  get privateState(): PS {
    return this.#state.private;
  }

  call<R = unknown>(circuit: string, ...args: unknown[]): Promise<R> {
    return this.callWith<R>({}, circuit, ...args);
  }

  callWith<R = unknown>(
    options: CallOptions,
    circuit: string,
    ...args: unknown[]
  ): Promise<R> {
    const next = this.#tail.then(() => this.#run(options, circuit, args));
    this.#tail = next;
    // The scenario awaits the tail, so an unawaited call's failure still surfaces once.
    next.catch(() => {});
    return next as Promise<R>;
  }

  async finish(): Promise<{ calls: ExecutedCall[]; state: State<PS> }> {
    await this.#tail;
    return { calls: this.#calls, state: this.#state };
  }

  async #run(
    options: CallOptions,
    circuit: string,
    args: unknown[],
  ): Promise<unknown> {
    const { contract, caller, contractAddress, time } = this.#runner;
    const circuitFn = contract.impureCircuits[circuit];
    if (typeof circuitFn !== 'function') {
      throw new Error(`the contract has no impure circuit ${circuit}`);
    }
    // A fresh context per call keeps the trace, gas and Zswap state to this call alone.
    const result = await circuitFn(
      createCircuitContext({
        circuitId: circuit,
        contractAddress,
        coinPublicKeyOrZswapState: options.caller ?? caller,
        contractState: this.#state.contract,
        privateState: clonePrivateState(this.#state.private),
        time,
      }),
      ...args,
    );
    const trace = result.context.callProofDataTrace;
    const proofData = trace.at(-1);
    if (proofData === undefined || trace.length !== 1) {
      throw new Error(
        `circuit ${circuit} recorded ${trace.length} contract calls; the profiler supports exactly one`,
      );
    }
    this.#calls.push({
      proofData,
      operation: this.#runner.operation(circuit),
    });
    this.#state = {
      contract: proofData.finalQueryContext.state,
      private: result.context.callContext.currentPrivateState as PS,
    };
    return result.result;
  }
}

/** A copy for one call, so a witness that changes its private state in place leaves the caller's intact. */
function clonePrivateState<PS>(state: PS): PS {
  try {
    return structuredClone(state);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the private state must be structured-cloneable: ${reason}`,
      { cause: error },
    );
  }
}

/** What a scenario needs from its profiler. */
interface Runner<PS> {
  contract: CompiledContract<PS>;
  caller: string;
  contractAddress: string;
  time: number;
  operation(circuit: string): ContractOperation;
}

/**
 * Executes scenarios against one deployed contract and writes one unproven transaction per
 * scenario plus the manifest `compact-profile` reads. Methods run one at a time, in call order.
 */
export class Profiler<PS> {
  readonly #options: ProfilerOptions<PS>;
  readonly #runner: Runner<PS>;
  readonly #settings: BuildSettings;
  readonly #paramsIdentity: string;
  readonly #toolchain: Record<string, string>;
  readonly #checkedNetworks = new Set<string>();
  #base: State<PS>;
  readonly #scenarios: ManifestScenario[] = [];
  readonly #slugs = new Map<string, string>();
  #queue: Promise<unknown> = Promise.resolve();

  /** Use {@link createProfiler}. */
  constructor(init: {
    options: ProfilerOptions<PS>;
    runner: Runner<PS>;
    settings: BuildSettings;
    paramsIdentity: string;
    toolchain: Record<string, string>;
    base: State<PS>;
  }) {
    this.#options = init.options;
    this.#runner = init.runner;
    this.#settings = init.settings;
    this.#paramsIdentity = init.paramsIdentity;
    this.#toolchain = init.toolchain;
    this.#base = init.base;
    this.#checkedNetworks.add(init.options.network);
  }

  /** The base state each scenario starts from. */
  get contractState(): ChargedState {
    return this.#base.contract;
  }

  get privateState(): PS {
    return this.#base.private;
  }

  /** Entries recorded so far, in manifest order. */
  get scenarios(): readonly ManifestScenario[] {
    return this.#scenarios;
  }

  scenario(name: string, build: Build<PS>): Promise<ManifestScenario>;
  scenario(
    name: string,
    options: ScenarioOptions,
    build: Build<PS>,
  ): Promise<ManifestScenario>;
  scenario(
    name: string,
    optionsOrBuild: ScenarioOptions | Build<PS>,
    maybeBuild?: Build<PS>,
  ): Promise<ManifestScenario> {
    const [options, build] =
      typeof optionsOrBuild === 'function'
        ? [{}, optionsOrBuild]
        : [optionsOrBuild, maybeBuild];
    if (build === undefined) {
      throw new Error(`scenario ${JSON.stringify(name)} has no build function`);
    }
    return this.#enqueue(async () => {
      this.#reserve(name);
      const built = await this.#build(build);
      return this.#record(
        { name, conflict: options.conflict, ops: options.ops },
        built,
      );
    });
  }

  /** One scenario per size; the manifest groups them as series `name`. */
  series(
    name: string,
    options: SeriesOptions,
    build: SizedBuild<PS>,
  ): Promise<ManifestScenario[]> {
    return this.#enqueue(async () => {
      this.#newSeries(name);
      const sizes = [...new Set(options.sizes)];
      if (sizes.length !== options.sizes.length) {
        throw new Error(`series ${JSON.stringify(name)} repeats a size`);
      }
      for (const n of sizes) {
        this.#reserve(memberName(name, n), n);
      }
      const recorded: ManifestScenario[] = [];
      for (const n of sizes) {
        const built = await this.#build((tx) => build(tx, n));
        recorded.push(this.#member(name, n, options, built));
      }
      return recorded;
    });
  }

  /**
   * The largest size whose transaction fits every per-transaction limit on `networks`, asked
   * of `compact-profile cost`: sizes double until one does not fit, then a binary search.
   * Records sizes 1, 2, 4 and 8 below the maximum, the maximum and the first size over.
   */
  searchMax(
    name: string,
    options: SearchOptions,
    build: SizedBuild<PS>,
  ): Promise<SearchResult> {
    return this.#enqueue(async () => {
      this.#newSeries(name);
      const cap = options.cap ?? 256;
      if (!Number.isInteger(cap) || cap < 1) {
        throw new Error(`searchMax cap must be a positive integer, got ${cap}`);
      }
      const networks = options.networks ?? [this.#options.network];
      if (networks.length === 0) {
        throw new Error(
          "searchMax needs at least one network; omit networks to search the profiler's",
        );
      }
      for (const network of networks) {
        await this.#checkClient(network);
      }
      const built = new Map<number, Built>();
      const verdicts = new Map<number, string | null>();
      const dir = mkdtempSync(join(tmpdir(), 'compact-profiler-search-'));
      const over = async (n: number): Promise<string | null> => {
        const cached = verdicts.get(n);
        if (cached !== undefined) return cached;
        const result = await this.#build((tx) => build(tx, n));
        built.set(n, result);
        const path = join(dir, `n${n}.tx`);
        writeFileSync(path, result.bytes);
        let binding: string | null = null;
        for (const network of networks) {
          const report: CostReport = await costTransaction(
            path,
            network,
            this.#options,
          );
          if (!report.fits) {
            binding = `${network}: ${report.binding}`;
            break;
          }
        }
        verdicts.set(n, binding);
        return binding;
      };

      let fits = 0;
      let firstOver: number | undefined;
      try {
        for (let n = 1; ; n = Math.min(n * 2, cap)) {
          if ((await over(n)) !== null) {
            firstOver = n;
            break;
          }
          fits = n;
          if (n === cap) break;
        }
        if (firstOver !== undefined) {
          while (firstOver - fits > 1) {
            const mid = Math.floor((fits + firstOver) / 2);
            if ((await over(mid)) === null) fits = mid;
            else firstOver = mid;
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      const sizes = [1, 2, 4, 8].filter((n) => n < fits);
      if (fits > 0) sizes.push(fits);
      if (firstOver !== undefined) sizes.push(firstOver);
      const recorded: ManifestScenario[] = [];
      for (const n of sizes) {
        this.#reserve(memberName(name, n), n);
      }
      for (const n of sizes) {
        const member =
          built.get(n) ?? (await this.#build((tx) => build(tx, n)));
        recorded.push(this.#member(name, n, options, member));
      }
      if (firstOver === undefined) {
        process.stderr.write(
          `compact-profiler: searchMax ${JSON.stringify(name)}: every size up to the cap ${cap} fits; raise cap to find the limit\n`,
        );
      }
      return {
        maxN: fits,
        capped: firstOver === undefined,
        binding:
          firstOver === undefined ? null : (verdicts.get(firstOver) ?? null),
        scenarios: recorded,
      };
    });
  }

  /** Runs calls on the base state without recording a transaction; later scenarios start there. */
  apply(build: Build<PS>): Promise<void> {
    return this.#enqueue(async () => {
      this.#base = (await this.#execute(build, this.#base)).state;
    });
  }

  /**
   * Writes `<outDir>/manifest.json` and removes transactions under `<outDir>/txs` it does not
   * list. Returns the manifest path.
   */
  write(): Promise<string> {
    return this.#enqueue(async () => {
      if (this.#scenarios.length === 0) {
        throw new Error(
          'no scenarios recorded; the manifest needs at least one',
        );
      }
      const manifest: Manifest = {
        schemaVersion: 1,
        contract: this.#options.name,
        toolchain: this.#toolchain,
        paramsIdentity: this.#paramsIdentity,
        scenarios: this.#scenarios,
      };
      const path = join(this.#options.outDir, 'manifest.json');
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
      const listed = new Set(this.#scenarios.map((entry) => entry.tx));
      const txs = join(this.#options.outDir, 'txs');
      for (const file of readdirSync(txs)) {
        if (file.endsWith('.tx') && !listed.has(`txs/${file}`)) {
          rmSync(join(txs, file));
        }
      }
      return path;
    });
  }

  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task);
    this.#queue = next.catch(() => {});
    return next;
  }

  #newSeries(name: string): void {
    if (this.#scenarios.some((entry) => entry.series === name)) {
      throw new Error(`series ${JSON.stringify(name)} is already recorded`);
    }
  }

  #reserve(name: string, n?: number): void {
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
      throw new Error(
        `size ${n} of ${JSON.stringify(name)} is not a positive integer`,
      );
    }
    if (this.#scenarios.some((entry) => entry.name === name)) {
      throw new Error(`scenario ${JSON.stringify(name)} is already recorded`);
    }
    const slug = slugify(name);
    const owner = this.#slugs.get(slug);
    if (owner !== undefined && owner !== name) {
      throw new Error(
        `scenarios ${JSON.stringify(owner)} and ${JSON.stringify(name)} share the file name txs/${slug}.tx`,
      );
    }
    this.#slugs.set(slug, name);
  }

  async #execute(
    build: Build<PS>,
    from: State<PS>,
  ): Promise<{ calls: ExecutedCall[]; state: State<PS> }> {
    const scenario = new Scenario(this.#runner, from);
    await build(scenario);
    return scenario.finish();
  }

  async #build(build: Build<PS>): Promise<Built> {
    const { calls } = await this.#execute(build, this.#base);
    const { bytes, measurement } = measure(
      scenarioTransaction(calls, this.#settings),
      this.#settings.params,
    );
    return { calls: calls.length, bytes, measurement };
  }

  #member(
    series: string,
    n: number,
    options: { conflict?: Conflict; ops?: number | ((n: number) => number) },
    built: Built,
  ): ManifestScenario {
    const ops =
      typeof options.ops === 'function' ? options.ops(n) : options.ops;
    return this.#record(
      {
        name: memberName(series, n),
        series,
        n,
        conflict: options.conflict,
        ops,
      },
      built,
    );
  }

  #record(
    entry: {
      name: string;
      series?: string;
      n?: number;
      conflict?: Conflict;
      ops?: number;
    },
    built: Built,
  ): ManifestScenario {
    const ops = entry.ops ?? built.calls;
    if (!Number.isInteger(ops) || ops < 1) {
      throw new Error(
        `scenario ${JSON.stringify(entry.name)} has ops ${ops}; ops must be a positive integer`,
      );
    }
    const tx = `txs/${slugify(entry.name)}.tx`;
    mkdirSync(join(this.#options.outDir, 'txs'), { recursive: true });
    writeFileSync(join(this.#options.outDir, tx), built.bytes);
    const scenario: ManifestScenario = {
      name: entry.name,
      ...(entry.series === undefined
        ? {}
        : { series: entry.series, n: entry.n }),
      calls: built.calls,
      ops,
      conflict: entry.conflict ?? 'none',
      tx,
      js: built.measurement,
    };
    this.#scenarios.push(scenario);
    return scenario;
  }

  async #checkClient(network: string): Promise<void> {
    if (this.#checkedNetworks.has(network)) return;
    this.#checkedNetworks.add(network);
    const params = await networkParams(network, this.#options);
    warnBelowMinimum(
      this.#toolchain[LEDGER]!,
      params.network,
      params.minClientLedger,
    );
  }
}

function memberName(series: string, n: number): string {
  return `${series} n=${n}`;
}

function warnBelowMinimum(
  client: string,
  network: string,
  minimum: string | null,
): void {
  if (minimum !== null && compareVersions(client, minimum) < 0) {
    process.stderr.write(
      `compact-profiler: warning: ${LEDGER} ${client} is below ${network}'s minimum client ledger ${minimum}; the network may refuse what this client builds\n`,
    );
  }
}

/**
 * Deploys `options.contract` in memory and reads `options.network`'s ledger parameters from
 * `compact-profile params`.
 */
export async function createProfiler<PS>(
  options: ProfilerOptions<PS>,
): Promise<Profiler<PS>> {
  const params = await networkParams(options.network, options);
  const toolchain = Object.fromEntries(
    Object.entries({
      [LEDGER]: resolvedVersion(LEDGER),
      [RUNTIME]: resolvedVersion(RUNTIME),
      ...options.toolchain,
    }).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  warnBelowMinimum(toolchain[LEDGER]!, params.network, params.minClientLedger);

  const keys = defaultCaller();
  const caller = options.caller ?? keys.coinPublicKey;
  const deployed = await options.contract.initialState(
    // ProfilerOptions lets `privateState` be omitted only when `undefined` is a `PS`.
    createConstructorContext(options.privateState as PS, caller),
    ...(options.constructorArgs ?? []),
  );
  const contractState: ContractState = deployed.currentContractState;
  const operations = new Map<string, ContractOperation>();
  const time = options.time ?? DEFAULTS.time;

  mkdirSync(options.outDir, { recursive: true });
  return new Profiler<PS>({
    options,
    runner: {
      contract: options.contract,
      caller,
      contractAddress: options.contractAddress ?? DEFAULTS.contractAddress,
      time,
      operation: (circuit) => {
        let operation = operations.get(circuit);
        if (operation === undefined) {
          // Crossing from the runtime's copy of the ledger types to ledger-v9's goes by bytes.
          const deployedOperation = contractState.operation(circuit);
          operation = deployedOperation
            ? ContractOperation.deserialize(deployedOperation.serialize())
            : new ContractOperation();
          operations.set(circuit, operation);
        }
        return operation;
      },
    },
    settings: {
      params: LedgerParameters.deserialize(params.bytes),
      networkId: options.networkId ?? DEFAULTS.networkId,
      ttl: options.ttl ?? new Date((time + 3600) * 1000),
      contractAddress: options.contractAddress ?? DEFAULTS.contractAddress,
      communicationRandomness: DEFAULTS.communicationRandomness,
      encryptionKey:
        options.encryptionPublicKey ?? (() => keys.encryptionPublicKey),
    },
    paramsIdentity: params.paramsIdentity,
    toolchain,
    base: {
      contract: contractState.data,
      private: deployed.currentPrivateState,
    },
  });
}
