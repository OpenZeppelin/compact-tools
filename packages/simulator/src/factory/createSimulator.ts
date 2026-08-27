import type { Backend, BackendKind, CircuitKind } from '../backend/Backend.js';
import { DryBackend, type SyncSimulator } from '../backend/DryBackend.js';
import { PrivateStateMutator } from '../core/PrivateStateMutator.js';
import type { LiveContext } from '../live/LiveContext.js';
import { getRegisteredLiveBackend } from '../live/registry.js';
import { Signers } from '../signers/Signers.js';
import type { IMinimalContract } from '../types/Contract.js';
import type {
  AsyncCircuits,
  ExtractImpureCircuits,
  ExtractPureCircuits,
} from '../types/index.js';
import type { SimulatorOptions } from '../types/Options.js';
import { createDrySimulator } from './createDrySimulator.js';
import type { SimulatorConfig } from './SimulatorConfig.js';

/**
 * Prepared backend wiring handed to the simulator constructor.
 *
 * Exported because it appears in `create` / `_create`, so a consumer that
 * assigns `createSimulator(...)` to an exported binding must be able to name it.
 */
export interface BackendDeps<P, L> {
  backend: Backend<P, L>;
  signers: Signers;
  pureNames: string[];
  impureNames: string[];
}

/**
 * Resolves the backend kind once: an explicit override wins, otherwise
 * `MIDNIGHT_BACKEND=live` selects live and anything else (unset or `dry`)
 * selects dry.
 */
const resolveBackendKind = (override?: BackendKind): BackendKind =>
  override ?? (process.env.MIDNIGHT_BACKEND === 'live' ? 'live' : 'dry');

/**
 * Creates a backend-aware simulator class for a contract.
 *
 * One factory, two backends: the produced class runs against the in-memory path
 * ({@link DryBackend}) or a live Midnight node (`LiveBackend`), selected by
 * `MIDNIGHT_BACKEND=dry|live` at construction. `create` is async and
 * circuits return promises ({@link AsyncCircuits}) so a single spec file runs on
 * both backends with uniform `await`.
 *
 * The live adapter is reached only through a runtime dynamic import: a static
 * `import { createSimulator }` never pulls midnight-js into the
 * dependency graph. In live mode the {@link LiveContext} comes from `options.live`
 * or the globally registered live backend (`registerLiveBackend`).
 *
 * @param config - The shared simulator configuration (same shape both backends).
 * @returns A class to extend with per-circuit delegating methods.
 */
export function createSimulator<
  P,
  L,
  W,
  TContract extends IMinimalContract,
  TArgs extends readonly any[] = readonly any[],
>(config: SimulatorConfig<P, L, W, TContract, TArgs>) {
  // Built once per factory; instances per `create()`. The synchronous primitive
  // is the whole dry path and the local JS artifact for pure-circuit eval.
  const DrySimClass = createDrySimulator<P, L, W, TContract, TArgs>(config);

  /**
   * Builds an async circuit proxy: each name becomes a function that routes to
   * `backend.call(kind, name, args)`, returning the bare `R` as a promise.
   */
  const buildProxy = (
    backend: Backend<P, L>,
    kind: CircuitKind,
    names: string[],
  ): Record<string, (...args: unknown[]) => Promise<unknown>> => {
    const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const name of names) {
      proxy[name] = (...args: unknown[]) => backend.call(kind, name, args);
    }
    return proxy;
  };

  /** Resolves backend selection, builds the backend, and derives circuit names. */
  const prepareBackend = async (
    contractArgs: TArgs,
    options: SimulatorOptions<P, W>,
  ): Promise<BackendDeps<P, L>> => {
    const kind = resolveBackendKind(options.backend);

    // The local synchronous simulator: the whole dry path, and the pure-circuit
    // evaluator in live (D2). In live this runs `initialState` in memory only —
    // it is never deployed on-chain.
    const localSim = new DrySimClass(contractArgs, options);
    // 0.18: `initialState` is async, so the constructor defers the constructor
    // run to `init()`. Await it before deriving names / wiring any backend.
    await localSim.init();
    const contract = localSim.contract;
    const impureNames = Object.keys(contract.impureCircuits);
    const impureSet = new Set(impureNames);
    const pureNames = Object.keys(contract.circuits).filter(
      (name) => !impureSet.has(name),
    );

    if (kind === 'live') {
      const signers = new Signers({
        mode: 'live',
        liveAliases: options.liveAliases,
        resolveLiveKey: options.resolveLiveKey,
      });

      // Prefer an explicit ctx; otherwise the globally registered live backend.
      let liveCtx = options.live;
      if (!liveCtx) {
        const factory = getRegisteredLiveBackend();
        if (factory) {
          liveCtx = (await factory({
            config,
            contractArgs,
            options,
          })) as LiveContext<P>;
        }
      }
      if (!liveCtx) {
        throw new Error(
          'live backend selected (MIDNIGHT_BACKEND=live) but no LiveContext available. ' +
            'Pass `{ live }` to create(), or call registerLiveBackend(...) in your ' +
            'test:live setup. The harness owns deploy/providers/wallets.',
        );
      }

      // The live adapter value is reached only via dynamic import,
      // so a dry import never statically links it (and any future heavy deps).
      const { LiveBackend } = await import('../live/LiveBackend.js');
      const backend = new LiveBackend<P, L>({
        ctx: liveCtx,
        pureSim: localSim as unknown as SyncSimulator<P, L>,
        signers,
        ledgerExtractor: config.ledgerExtractor,
      });
      return { backend, signers, pureNames, impureNames };
    }

    const signers = new Signers({ mode: 'dry', dryKeys: options.signerKeys });
    const backend = new DryBackend<P, L>(
      localSim as unknown as SyncSimulator<P, L>,
      signers,
    );
    return { backend, signers, pureNames, impureNames };
  };

  return class Simulator {
    /** The backend this instance resolved to at construction. */
    readonly backendKind: BackendKind;

    // Public (underscore-prefixed) to satisfy declaration emit for the returned
    // anonymous class; treat as internal.
    readonly _backend: Backend<P, L>;
    readonly _signers: Signers;

    /**
     * Serializes private-state read-modify-write for this instance. Internal;
     * see {@link PrivateStateMutator} for the scope of the guarantee.
     */
    readonly _mutator: PrivateStateMutator<P>;

    /** Async circuit proxies; every call returns a promise. */
    readonly circuits: {
      pure: AsyncCircuits<ExtractPureCircuits<TContract>, P>;
      impure: AsyncCircuits<ExtractImpureCircuits<TContract>, P>;
    };

    /**
     * Internal constructor. Use the async static {@link create} instead — it
     * resolves the backend (including the live dynamic import) before construction.
     *
     * @param deps - Prepared backend wiring from {@link prepareBackend}.
     */
    constructor(deps: BackendDeps<P, L>) {
      this._backend = deps.backend;
      this.backendKind = deps.backend.kind;
      this._signers = deps.signers;
      // Constructed here (not as a field initializer) so the closures capture
      // the assigned `_backend` rather than an undefined one.
      this._mutator = new PrivateStateMutator<P>(
        () => this._backend.getPrivateState(),
        (next) => this._backend.setPrivateState(next),
      );
      this.circuits = {
        pure: buildProxy(
          this._backend,
          'pure',
          deps.pureNames,
        ) as unknown as AsyncCircuits<ExtractPureCircuits<TContract>, P>,
        impure: buildProxy(
          this._backend,
          'impure',
          deps.impureNames,
        ) as unknown as AsyncCircuits<ExtractImpureCircuits<TContract>, P>,
      };
    }

    /**
     * Public entry point. Permissive params so subclasses can override `create`
     * with contract-specific signatures without tripping TS's static-side
     * `extends` check. Subclass overrides should assemble the typed args tuple
     * and call {@link _create} (`super._create([...args], options)`) so the
     * tuple is checked against `TArgs` — delegating back to this permissive
     * `create` would silently skip that check.
     *
     * @param args - `[contractArgs?, options?]`, validated by `_create`.
     * @returns The constructed simulator, typed as the base `Simulator`; subclass
     *   `create` overrides narrow the return to their own type.
     */
    static async create(
      this: new (
        deps: BackendDeps<P, L>,
      ) => Simulator,
      ...args: unknown[]
    ): Promise<Simulator> {
      const [contractArgs, options] = args as [TArgs?, SimulatorOptions<P, W>?];
      // biome-ignore lint/complexity/noThisInStatic: keep the caller's `this` so a non-overriding subclass constructs its own type, not the base `Simulator` (the autofix rewrites `this`->`Simulator`, breaking that at runtime).
      return (this as unknown as typeof Simulator)._create(
        contractArgs,
        options,
      );
    }

    /**
     * Typed construction path. In dry, deploys from `contractArgs` to fresh
     * in-memory state; in live the caller already deployed and the args seed
     * only the local pure-eval context. Subclass `create` overrides call this
     * (`super._create([...typedArgs], options)`) so their args tuple is checked
     * against `TArgs`. Underscore-public to match the `_backend`/`_signers`
     * convention for declaration emit.
     *
     * @param contractArgs - Constructor args for the contract.
     * @param options - Backend selection, witnesses, private state, live world.
     * @returns The constructed simulator, typed as the base `Simulator`; subclass
     *   `create` overrides narrow the return to their own type. The runtime
     *   instance is the caller's class (constructed via `this`).
     */
    static async _create(
      this: new (
        deps: BackendDeps<P, L>,
      ) => Simulator,
      contractArgs: TArgs = [] as unknown as TArgs,
      options: SimulatorOptions<P, W> = {},
    ): Promise<Simulator> {
      const deps = await prepareBackend(contractArgs, options);
      return new this(deps);
    }

    /** The alias resolver for circuit-arg keys (`signers.eitherFor('OWNER')`). */
    get signers(): Signers {
      return this._signers;
    }

    /**
     * The deployed contract's address. Needed by callers that must reconstruct
     * a circuit's message digest off-chain (e.g. signing an operation bound to
     * `kernel.self()`).
     */
    get contractAddress(): string {
      return this._backend.contractAddress;
    }

    /**
     * Sets the caller for the next call only, then reverts.
     *
     * @param alias - The caller alias, or `null` for the default signer.
     * @returns This instance, for chaining (`sim.as('OWNER').transfer(...)`).
     */
    as(alias: string | null): this {
      this._backend.setCaller(alias, 'single');
      return this;
    }

    /**
     * Sets a persistent caller for all subsequent calls until changed.
     *
     * @param alias - The caller alias, or `null` to clear.
     * @returns This instance, for chaining.
     */
    setPersistentCaller(alias: string | null): this {
      this._backend.setCaller(alias, 'persistent');
      return this;
    }

    /** Clears the persistent caller (the single-shot caller self-resets per call). */
    resetCaller(): this {
      this._backend.setCaller(null, 'persistent');
      return this;
    }

    /** The public ledger state, via the shared extractor. */
    getPublicState(): Promise<L> {
      return this._backend.getPublicState();
    }

    /** The private state (read parity across backends). */
    getPrivateState(): Promise<P> {
      return this._backend.getPrivateState();
    }

    /**
     * Replaces the whole private state. Dry mutates the in-memory context; live
     * writes to the harness's private-state provider so the next impure call
     * proves against it (throws if the `LiveContext` opted out of mutation).
     * Serialized against other mutations via {@link _mutator}.
     *
     * @param privateState - The new private state.
     */
    setPrivateState(privateState: P): Promise<void> {
      return this._mutator.set(privateState);
    }

    /**
     * Ergonomic granular private-state mutation. Replaces the per-module
     * `injectSecretKey`/`injectSecretNonce` helpers: a plain object shallow-
     * merges onto the current state, a function receives the current state and
     * returns the next.
     *
     * The read-modify-write is serialized (see {@link _mutator}) and resolves to
     * the state that was written, so callers can `return sim.updatePrivateState(...)`
     * without a follow-up `getPrivateState()`. Works on both dry (in-memory) and
     * live (provider read then write); on live the current state must already
     * exist (it is seeded at deploy).
     *
     * @example sim.updatePrivateState({ secretKey });
     * @example sim.updatePrivateState((prev) => ({ ...prev, counter: prev.counter + 1n }));
     *
     * @param updater - A partial patch to merge, or an updater function.
     * @returns The private state that was written.
     */
    updatePrivateState(updater: Partial<P> | ((prev: P) => P)): Promise<P> {
      return this._mutator.update(updater);
    }

    /** The raw contract state value. */
    getContractState() {
      return this._backend.getContractState();
    }

    /** The current witness set. */
    get witnesses(): W {
      return this._backend.getWitnesses() as W;
    }

    /**
     * Replaces the whole witness set. Dry recreates the contract; live throws.
     * Equivalent to {@link setWitnesses}; kept for API compatibility.
     */
    set witnesses(newWitnesses: W) {
      this._backend.setWitnesses(newWitnesses);
    }

    /**
     * Overrides a single witness. Dry recreates the contract; live throws.
     *
     * @param key - The witness key.
     * @param fn - The replacement implementation.
     */
    overrideWitness<K extends keyof W>(key: K, fn: W[K]): void {
      this._backend.overrideWitness(key as PropertyKey, fn);
    }

    /**
     * Replaces the whole witness set. Dry recreates the contract; live throws.
     *
     * @param witnesses - The new witness set.
     */
    setWitnesses(witnesses: W): void {
      this._backend.setWitnesses(witnesses);
    }
  };
}
