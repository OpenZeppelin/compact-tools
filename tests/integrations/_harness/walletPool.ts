import type {
  EnvironmentConfiguration,
  MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import { WalletHandler } from '@openzeppelin/compact-deployer/wallet/handler';
import {
  classifySeed,
  localPrefundedSeed,
} from '@openzeppelin/compact-deployer/wallet/seeds';
import { testLogger } from './logger.ts';
import { localNetworkConfig } from './network.ts';
import { ROOT_DIR } from './paths.ts';

/**
 * Aliases mapped to slots in the deployer's `LOCAL_PREFUNDED_SEEDS`, the
 * accounts `midnight-node --preset=dev` funds at genesis. Slot 0 is
 * `TEST_MNEMONIC` (routed through `FluentWalletBuilder.withMnemonic`);
 * slots 1..4 are hex seeds (`withSeed`).
 */
export const PREFUNDED_SLOTS = {
  DEPLOYER: 0,
  ALICE: 1,
  BOB: 2,
  CHARLIE: 3,
  DAVE: 4,
} as const;

export type PoolAlias = keyof typeof PREFUNDED_SLOTS;

/**
 * Process-shared pool of test wallets keyed by alias.
 *
 * Wallet startup (`build` + sync) is the slowest part of the suite, so the
 * pool caches one promise per alias. `signerFor()` is safe to call from
 * `beforeAll` in every spec — repeated calls return the same warm wallet.
 * Specs that need wallet isolation can construct their own pool instance.
 */
export class WalletPool {
  readonly #cache = new Map<PoolAlias, Promise<WalletHandler>>();
  readonly #env: EnvironmentConfiguration;

  constructor(env: EnvironmentConfiguration) {
    this.#env = env;
  }

  async signerFor(alias: PoolAlias): Promise<MidnightWalletProvider> {
    return (await this.#ownedFor(alias)).provider;
  }

  #ownedFor(alias: PoolAlias): Promise<WalletHandler> {
    const cached = this.#cache.get(alias);
    if (cached) return cached;

    const built = (async () => {
      const owned = await WalletHandler.build(
        testLogger(),
        this.#env,
        classifySeed(localPrefundedSeed(PREFUNDED_SLOTS[alias])),
        // `make env-down` wipes the chain, so a snapshot from a previous
        // run would restore UTXOs that no longer exist. Local sync from
        // genesis is seconds; always take it.
        { rootDir: ROOT_DIR, skipWalletCache: true },
      );
      await owned.provider.start(true);
      return owned;
    })();
    // Evict on failure so a rejected build isn't cached forever: otherwise
    // every later signerFor(alias) would replay the same rejection with no
    // chance to retry.
    const guarded = built.catch((err) => {
      this.#cache.delete(alias);
      throw err;
    });
    this.#cache.set(alias, guarded);
    return guarded;
  }

  /** Stop every cached wallet and clear the cache. Call from `afterAll()`. */
  async reset(): Promise<void> {
    const entries = Array.from(this.#cache.values());
    this.#cache.clear();
    await Promise.all(
      entries.map(async (p) => {
        try {
          await (await p)[Symbol.asyncDispose]();
        } catch {
          /* ignore stop errors during teardown */
        }
      }),
    );
  }
}

let sharedPool: WalletPool | undefined;

/**
 * Process-singleton pool over the local stack, released when the vitest
 * worker exits. A spec that would tear its wallets down mid-suite
 * constructs its own {@link WalletPool} instead.
 */
export function getSharedPool(): WalletPool {
  if (!sharedPool) sharedPool = new WalletPool(localNetworkConfig());
  return sharedPool;
}
