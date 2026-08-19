import type { StateValue } from '@midnight-ntwrk/compact-runtime';
// Type-only imports — erased at build, so they create no runtime edge to
// midnight-js. The only runtime midnight-js edge in this file is the
// lazy dynamic import inside `loadFindDeployedContract`.
import type {
  PrivateStateProvider,
  PublicDataProvider,
} from '@midnight-ntwrk/midnight-js-types';
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
 * construction, and wallet funding are the caller's harness. Provider
 * and contract specifics are threaded through opaquely — the harness owns their
 * construction and types.
 *
 * @template P - Private state type.
 */
export interface CreateLiveContextOptions<P> {
  /** The address of the already-deployed contract. */
  contractAddress: string;
  /**
   * Per-alias `ContractProviders`, supplied by the harness. The wallet/signing
   * differs per alias; `null` is the default signer. Threaded into
   * `findDeployedContract`.
   */
  providersFor: (alias: string | null) => unknown;
  /** The compiled contract, from the harness. Threaded into `findDeployedContract`. */
  compiledContract: unknown;
  /** Identifier under which the contract's private state is stored. */
  privateStateId: string;
  /** Provider for reading on-chain public state. */
  publicDataProvider: PublicDataProvider;
  /**
   * Provider for reading and (optionally) writing private state.
   *
   * Invariant: this MUST be the same provider instance wired into the
   * `providersFor(alias)` bundle handed to `findDeployedContract`. The
   * `setPrivateState` write below targets this provider, and the next
   * `callTx` reads private state from the bundle's provider; if they are
   * different instances the write is invisible to proving. `setContractAddress`
   * is the harness's responsibility (already required for `get`).
   */
  privateStateProvider: PrivateStateProvider<string, P>;
  /** Optional override of the indexer-lag policy. */
  indexerLag?: Partial<IndexerLagPolicy>;
}

type FindDeployedContractFn = (
  providers: unknown,
  options: unknown,
) => Promise<{ callTx: DeployedTxHandle['callTx'] }>;

let cachedFindDeployedContract: FindDeployedContractFn | undefined;

/**
 * Lazily loads `findDeployedContract`. The dynamic import is the sole runtime
 * edge to midnight-js in the package's graph; a failure to resolve it (the
 * optional peers are absent) is rewrapped into an actionable message
 * rather than a raw `ERR_MODULE_NOT_FOUND`.
 */
const loadFindDeployedContract = async (): Promise<FindDeployedContractFn> => {
  if (cachedFindDeployedContract) return cachedFindDeployedContract;
  try {
    const mod = await import('@midnight-ntwrk/midnight-js-contracts');
    cachedFindDeployedContract =
      mod.findDeployedContract as unknown as FindDeployedContractFn;
  } catch (cause) {
    throw new Error(
      'install @midnight-ntwrk/midnight-js-contracts (and the midnight-js peers) ' +
        'to use live mode',
      { cause },
    );
  }
  return cachedFindDeployedContract;
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
 * @param options - Harness-provided providers, contract, and address.
 * @returns A {@link LiveContext} ready to pass to `create(args, { live })`.
 */
export function createLiveContext<P>(
  options: CreateLiveContextOptions<P>,
): LiveContext<P> {
  const lag: IndexerLagPolicy = {
    ...DEFAULT_INDEXER_LAG,
    ...options.indexerLag,
  };
  const handleCache = new Map<string, Promise<DeployedTxHandle>>();

  const resolveHandle = (alias: string | null): Promise<DeployedTxHandle> => {
    const key = alias ?? '\u0000default';
    const cached = handleCache.get(key);
    if (cached) return cached;
    const built = loadFindDeployedContract().then((findDeployedContract) =>
      findDeployedContract(options.providersFor(alias), {
        compiledContract: options.compiledContract,
        contractAddress: options.contractAddress,
        privateStateId: options.privateStateId,
      }),
    );
    handleCache.set(key, built);
    return built;
  };

  return {
    contractAddress: options.contractAddress,

    handleFor: resolveHandle,

    /**
     * Polls the indexer for the contract state, retrying a bounded number of
     * times with capped exponential backoff to absorb block-lag after a
     * confirmed write. Returns the `StateValue` the shared
     * `ledgerExtractor` consumes.
     */
    async queryLedger(): Promise<StateValue> {
      let delay = lag.baseDelayMs;
      let lastErr: unknown;
      for (let attempt = 0; attempt <= lag.retries; attempt++) {
        try {
          const state = await options.publicDataProvider.queryContractState(
            options.contractAddress,
          );
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
        `no contract state at ${options.contractAddress} after ${lag.retries + 1} ` +
          'attempts — the write may be missing, or indexer lag exceeds the budget',
        lastErr === undefined ? undefined : { cause: lastErr },
      );
    },

    async queryPrivateState(): Promise<P> {
      const state = await options.privateStateProvider.get(
        options.privateStateId,
      );
      if (state == null) {
        throw new Error(
          `no private state stored at "${options.privateStateId}"`,
        );
      }
      return state;
    },

    /**
     * Writes the whole private state to the provider under `privateStateId`.
     * The next impure `callTx` reads it fresh (no handle-cache invalidation
     * needed). See the invariant on {@link CreateLiveContextOptions.privateStateProvider}.
     */
    async setPrivateState(state: P): Promise<void> {
      await options.privateStateProvider.set(options.privateStateId, state);
    },
  };
}
