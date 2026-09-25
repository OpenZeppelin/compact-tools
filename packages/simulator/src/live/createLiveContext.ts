import type { Contract } from '@midnight-ntwrk/compact-js';
import type { StateValue } from '@midnight-ntwrk/compact-runtime';
// Type-only imports — erased at build, so they create no runtime edge to
// midnight-js. The only runtime midnight-js edge in this file is the
// lazy dynamic import inside `loadContracts`.
import type {
  ContractProviders,
  FindDeployedContractOptionsExistingPrivateState,
  ScopedTransactionOptions,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { DeployedTxHandle, LiveContext } from './LiveContext.js';

/**
 * Bounded retry policy for absorbing indexer block-lag on public-state reads.
 * Always finite: a genuinely missing write fails the suite rather than
 * hanging it. Defaults concretize OQ2 and should be tuned against a real node.
 */
export interface IndexerLagPolicy {
  /** Max poll attempts before giving up. */
  retries: number;
  /** Initial backoff between attempts, in ms. */
  baseDelayMs: number;
  /** Backoff ceiling, in ms. */
  maxDelayMs: number;
}

/** Default indexer-lag policy (OQ2 — provisional, tune against a live node). */
export const DEFAULT_INDEXER_LAG: IndexerLagPolicy = {
  retries: 8,
  baseDelayMs: 150,
  maxDelayMs: 2000,
};

/**
 * Options for {@link createLiveContext}.
 *
 * The package only assembles already-provided pieces; deploy, provider
 * construction, and wallet funding are the caller's harness.
 *
 * @template C - Contract type.
 */
export interface CreateLiveContextOptions<
  C extends Contract.Any = Contract.Any,
> {
  /**
   * Per-alias providers; `null` is the default signer. Public and private
   * state are read through `providersFor(null)`, so aliases should share its
   * private-state provider, and the harness calls its `setContractAddress`.
   */
  providersFor: (alias: string | null) => ContractProviders<C>;
  /** Passed to `findDeployedContract` for every alias. */
  findOptions: FindDeployedContractOptionsExistingPrivateState<C>;
  /** Runs every live call in a midnight-js scoped transaction with these options. */
  scopedTransactionOptions?: ScopedTransactionOptions;
  /** Optional override of the indexer-lag policy. */
  indexerLag?: Partial<IndexerLagPolicy>;
}

type Contracts = typeof import('@midnight-ntwrk/midnight-js-contracts');

let cachedContracts: Contracts | undefined;

/**
 * Lazily loads midnight-js-contracts. The dynamic import is the sole runtime
 * edge to midnight-js in the package's graph; a failure to resolve it (the
 * optional peers are absent) is rewrapped into an actionable message
 * rather than a raw `ERR_MODULE_NOT_FOUND`.
 */
const loadContracts = async (): Promise<Contracts> => {
  if (cachedContracts) return cachedContracts;
  try {
    cachedContracts = await import('@midnight-ntwrk/midnight-js-contracts');
  } catch (cause) {
    throw new Error(
      'install @midnight-ntwrk/midnight-js-contracts (and the midnight-js peers) ' +
        'to use live mode',
      { cause },
    );
  }
  return cachedContracts;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Assembles a {@link LiveContext} from harness-provided pieces.
 *
 * Provides three things the harness would otherwise hand-roll: a per-alias
 * deployed-handle cache (via `findDeployedContract`), a public-state reader that
 * absorbs bounded indexer lag, and a private-state reader. The
 * adapter ({@link LiveContext}) stays thin; this helper is separate and
 * imported only by live consumers (who already depend on midnight-js).
 *
 * @param options - Harness-provided providers and `findDeployedContract` options.
 * @returns A {@link LiveContext} ready to pass to `create(args, { live })`.
 */
export function createLiveContext<C extends Contract.Any>(
  options: CreateLiveContextOptions<C>,
): LiveContext<Contract.PrivateState<C>> {
  const lag: IndexerLagPolicy = {
    ...DEFAULT_INDEXER_LAG,
    ...options.indexerLag,
  };
  const { findOptions, scopedTransactionOptions } = options;
  const { contractAddress, privateStateId } = findOptions;
  const handleCache = new Map<string, Promise<DeployedTxHandle>>();

  const resolveHandle = (alias: string | null): Promise<DeployedTxHandle> => {
    const key = alias ?? '\u0000default';
    const cached = handleCache.get(key);
    if (cached) return cached;
    const built = loadContracts().then(async (contracts) => {
      const providers = options.providersFor(alias);
      const found = await contracts.findDeployedContract(
        providers,
        findOptions,
      );
      // Erase `FoundContract<C>` to the structural handle `LiveBackend` reads;
      // its typed `callTx` overloads are not assignable to `DeployedTxHandle`.
      const handle = found as unknown as DeployedTxHandle;
      if (scopedTransactionOptions === undefined) return handle;
      // A scoped transaction is the only midnight-js entry point that takes
      // these options, so each call becomes a scope holding just that call.
      const callTx = Object.fromEntries(
        Object.entries(handle.callTx).map(([circuitId, call]) => [
          circuitId,
          (...args: unknown[]) =>
            contracts.withContractScopedTransaction(
              providers,
              async (txCtx) => {
                await call(txCtx, ...args);
              },
              scopedTransactionOptions,
            ),
        ]),
      );
      return { ...handle, callTx };
    });
    handleCache.set(key, built);
    return built;
  };

  return {
    contractAddress,

    handleFor: resolveHandle,

    /**
     * Polls the indexer for the contract state, retrying a bounded number of
     * times with capped exponential backoff to absorb block-lag after a
     * confirmed write. Returns the `StateValue` the shared
     * `ledgerExtractor` consumes.
     */
    async queryLedger(): Promise<StateValue> {
      const { publicDataProvider } = options.providersFor(null);
      let delay = lag.baseDelayMs;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= lag.retries; attempt++) {
        try {
          const state =
            await publicDataProvider.queryContractState(contractAddress);
          if (state != null) {
            // `ContractState.data` is the StateValue the dry path also extracts.
            return (state as unknown as { data: StateValue }).data;
          }
        } catch (err) {
          lastErr = err;
        }
        if (attempt < lag.retries) {
          await sleep(delay);
          delay = Math.min(delay * 2, lag.maxDelayMs);
        }
      }
      throw new Error(
        `no contract state at ${contractAddress} after ${lag.retries + 1} ` +
          'attempts — the write may be missing, or indexer lag exceeds the budget',
        lastErr === undefined ? undefined : { cause: lastErr },
      );
    },

    async queryPrivateState(): Promise<Contract.PrivateState<C>> {
      const { privateStateProvider } = options.providersFor(null);
      const state = await privateStateProvider.get(privateStateId);
      if (state == null) {
        throw new Error(`no private state stored at "${privateStateId}"`);
      }
      return state;
    },

    /**
     * Writes the whole private state under `privateStateId`. The next impure
     * `callTx` reads it fresh (no handle-cache invalidation needed).
     */
    async setPrivateState(state: Contract.PrivateState<C>): Promise<void> {
      const { privateStateProvider } = options.providersFor(null);
      await privateStateProvider.set(privateStateId, state);
    },
  };
}
