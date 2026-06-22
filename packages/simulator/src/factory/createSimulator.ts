import type { Backend, BackendKind, CircuitKind } from '../backend/Backend.js';
import { DryBackend, type SyncSimulator } from '../backend/DryBackend.js';
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

/** Prepared backend wiring handed to the simulator constructor. */
interface BackendDeps<P, L> {
  backend: Backend<P, L>;
  signers: Signers;
  pureNames: string[];
  impureNames: string[];
}

/**
 * Resolves the backend kind once: an explicit override wins, otherwise
 * `MIDNIGHT_BACKEND=live` selects live and anything else (unset or `dry`)
 * selects dry (INV-8).
 */
const resolveBackendKind = (override?: BackendKind): BackendKind =>
  override ?? (process.env.MIDNIGHT_BACKEND === 'live' ? 'live' : 'dry');

/**
 * Creates a backend-aware simulator class for a contract.
 *
 * One factory, two backends: the produced class runs against the in-memory path
 * ({@link DryBackend}) or a live Midnight node (`LiveBackend`), selected by
 * `MIDNIGHT_BACKEND=dry|live` at construction (INV-8). `create` is async and
 * circuits return promises ({@link AsyncCircuits}) so a single spec file runs on
 * both backends with uniform `await` (INV-4).
 *
 * The live adapter is reached only through a runtime dynamic import (INV-1,
 * INV-2): a static `import { createSimulator }` never pulls midnight-js into the
 * dependency graph. In live mode the {@link LiveContext} comes from `options.live`
 * or the globally registered live backend (`registerLiveBackend`).
 *
 * @param config - The shared simulator configuration (same shape both backends, INV-5).
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
  // is the whole dry path and the local JS artifact for pure-circuit eval (INV-16).
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
    // it is never deployed on-chain (INV-10).
    const localSim = new DrySimClass(contractArgs, options);
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
            'test:live setup. The harness owns deploy/providers/wallets (INV-22).',
        );
      }

      // INV-1/INV-2: the live adapter value is reached only via dynamic import,
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
    /** The backend this instance resolved to at construction (INV-8). */
    readonly backendKind: BackendKind;

    // Public (underscore-prefixed) to satisfy declaration emit for the returned
    // anonymous class; treat as internal.
    readonly _backend: Backend<P, L>;
    readonly _signers: Signers;

    /** Async circuit proxies; every call returns a promise (INV-4). */
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
     * Constructs a simulator. In dry, deploys from `contractArgs` to fresh
     * in-memory state. In live, the caller already deployed; the args seed only
     * the local pure-eval context, never an on-chain deploy (INV-10).
     *
     * @param contractArgs - Constructor args for the contract.
     * @param options - Backend selection, witnesses, private state, live world.
     * @returns The constructed simulator (subclass-aware via `this`).
     */
    static async create<T extends Simulator>(
      this: new (
        deps: BackendDeps<P, L>,
      ) => T,
      contractArgs: TArgs = [] as unknown as TArgs,
      options: SimulatorOptions<P, W> = {},
    ): Promise<T> {
      const deps = await prepareBackend(contractArgs, options);
      return new this(deps);
    }

    /** The alias resolver for circuit-arg keys (`signers.eitherFor('OWNER')`). */
    get signers(): Signers {
      return this._signers;
    }

    /**
     * Sets the caller for the next call only, then reverts (INV-17).
     *
     * @param alias - The caller alias, or `null` for the default signer.
     * @returns This instance, for chaining (`sim.as('OWNER').transfer(...)`).
     */
    as(alias: string | null): this {
      this._backend.setCaller(alias, 'single');
      return this;
    }

    /**
     * Sets a persistent caller for all subsequent calls until changed (INV-17).
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

    /** The public ledger state, via the shared extractor (INV-15). */
    getPublicState(): Promise<L> {
      return this._backend.getPublicState();
    }

    /** The private state (read parity across backends, INV-18). */
    getPrivateState(): Promise<P> {
      return this._backend.getPrivateState();
    }

    /**
     * Replaces the private state (for per-module secret/nonce injection helpers).
     * Dry mutates the in-memory context; live throws (INV-18 mutation asymmetry) —
     * guard such specs with `isLiveBackend()`.
     *
     * @param privateState - The new private state.
     */
    setPrivateState(privateState: P): void {
      this._backend.setPrivateState(privateState);
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
     * Replaces the whole witness set. Dry recreates the contract; live throws
     * (INV-7). Equivalent to {@link setWitnesses}; kept for API compatibility.
     */
    set witnesses(newWitnesses: W) {
      this._backend.setWitnesses(newWitnesses);
    }

    /**
     * Overrides a single witness. Dry recreates the contract; live throws (INV-7).
     *
     * @param key - The witness key.
     * @param fn - The replacement implementation.
     */
    overrideWitness<K extends keyof W>(key: K, fn: W[K]): void {
      this._backend.overrideWitness(key as PropertyKey, fn);
    }

    /**
     * Replaces the whole witness set. Dry recreates the contract; live throws (INV-7).
     *
     * @param witnesses - The new witness set.
     */
    setWitnesses(witnesses: W): void {
      this._backend.setWitnesses(witnesses);
    }
  };
}
