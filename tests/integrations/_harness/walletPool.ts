import {
  type EnvironmentConfiguration,
  type MidnightWalletProvider,
  TEST_MNEMONIC,
} from '@midnight-ntwrk/testkit-js';
import { classifySeed, WalletHandler } from '@openzeppelin/compact-deployer';
import { testLogger } from './logger.ts';

/**
 * Aliases mapped to seeds prefunded by `midnight-node --preset=dev`.
 *
 * - `DEPLOYER` uses `TEST_MNEMONIC`, the canonical `abandon × 23 diesel`
 *   BIP39 phrase recognised by the dev preset as the genesis-funded
 *   account. Routed through `FluentWalletBuilder.withMnemonic`.
 * - `ALICE`/`BOB`/`CHARLIE`/`DAVE` map to the hex seeds the standalone
 *   testkit exposes via `LocalTestEnvironment.genesisMintWalletSeed`.
 *   Routed through `FluentWalletBuilder.withSeed`.
 */
export const PREFUNDED_SEEDS = {
  DEPLOYER: TEST_MNEMONIC,
  ALICE: '0000000000000000000000000000000000000000000000000000000000000001',
  BOB: '0000000000000000000000000000000000000000000000000000000000000002',
  CHARLIE: '0000000000000000000000000000000000000000000000000000000000000003',
  DAVE: '0000000000000000000000000000000000000000000000000000000000000004',
} as const;

export type PoolAlias = keyof typeof PREFUNDED_SEEDS;

/**
 * Process-shared pool of test wallets keyed by alias.
 *
 * Wallet startup (`build` + sync) is the slowest part of the suite, so the
 * pool caches one promise per alias. `signerFor()` is safe to call from
 * `beforeAll` in every spec — repeated calls return the same warm wallet.
 * Specs that need wallet isolation can construct their own pool instance.
 */
export class WalletPool {
  private cache = new Map<PoolAlias, Promise<WalletHandler>>();

  constructor(private readonly env: EnvironmentConfiguration) {}

  async signerFor(alias: PoolAlias): Promise<MidnightWalletProvider> {
    return (await this.ownedFor(alias)).provider;
  }

  private ownedFor(alias: PoolAlias): Promise<WalletHandler> {
    const seedString = PREFUNDED_SEEDS[alias];
    if (seedString === undefined) {
      throw new Error(
        `WalletPool: unknown alias '${alias}'. Available: ${Object.keys(PREFUNDED_SEEDS).join(', ')}`,
      );
    }
    const cached = this.cache.get(alias);
    if (cached) return cached;

    const built = (async () => {
      const owned = await WalletHandler.build(
        testLogger(),
        this.env,
        classifySeed(seedString),
      );
      await owned.provider.start(true);
      return owned;
    })();
    this.cache.set(alias, built);
    return built;
  }

  /** Stop every cached wallet and clear the cache. Call from `afterAll()`. */
  async reset(): Promise<void> {
    const entries = Array.from(this.cache.values());
    this.cache.clear();
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
 * Process-singleton pool. First call builds it against `env`; subsequent
 * calls return the cached instance. Reset via `resetSharedPool()`.
 */
export function getSharedPool(env: EnvironmentConfiguration): WalletPool {
  if (!sharedPool) sharedPool = new WalletPool(env);
  return sharedPool;
}

export async function resetSharedPool(): Promise<void> {
  if (!sharedPool) return;
  await sharedPool.reset();
  sharedPool = undefined;
}
