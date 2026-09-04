import { DustSecretKey, ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';
import {
  DEFAULT_DUST_OPTIONS,
  type DustWalletOptions,
  type EnvironmentConfiguration,
  FluentWalletBuilder,
  MidnightWalletProvider,
  WalletFactory,
  WalletSeeds,
} from '@midnight-ntwrk/testkit-js';
import type { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import {
  createKeystore,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import type { Logger } from 'pino';
import { formatError } from '../services/error-format.ts';
import type { ConfigShape } from '../services/wallet-cache.ts';
import { WalletCache } from '../services/wallet-cache.ts';
import type { WalletSeed } from './seeds.ts';

/**
 * Subset of the wallet-SDK sync `batchUpdates` knob we set. The SDK only
 * exports it from an unstable deep path (`wallet-sdk-<pkg>/dist/v1/Sync`),
 * so we declare the shape we use locally.
 */
interface BatchUpdatesConfig {
  size?: number;
  timeout?: number;
  spacing?: number;
}

/**
 * Default sync batch size for the shielded + dust sub-wallets, overridable
 * per build via {@link WalletHandlerBuildOptions.syncBatchSize}. The SDK
 * default (size 10) exhausts the V8 heap replaying preprod's ~1M-event
 * global dust stream on `wallet-sdk-dust-wallet@4.0.0`
 * (midnightntwrk/midnight-wallet#425, "Ineffective mark-compacts near heap
 * limit"). A larger batch streams the replay in bigger chunks; size 5000
 * was validated at ~146 MB peak, ~1000 events/sec. Kept on the shipped
 * 4.1.0, which has not been run without it.
 */
const DEFAULT_SYNC_BATCH_SIZE = 5000;

/** `timeout`/`spacing` companions to the batch size; left at the validated values. */
const SYNC_BATCH_TIMING = { timeout: 1, spacing: 4 } as const;

export interface WalletHandlerBuildOptions {
  /** Directory `compact.toml` was loaded from; see `CompactConfig.rootDir`. */
  rootDir: string;
  /** Force a fresh sync from genesis (skip the on-disk cache). Default `false`. */
  skipWalletCache?: boolean;
  /**
   * Import a pre-warmed dust wallet state file into `.states/` before
   * the restore path runs. Accepts raw JSON (output of
   * `DustWallet.serializeState()`) or a gzipped copy; gzip is detected
   * by magic bytes. Overwrites any existing cache for the seed.
   * Ignored under {@link skipWalletCache}.
   */
  seedCacheDust?: string;
  /** Like {@link seedCacheDust} but for the shielded sub-wallet. */
  seedCacheShielded?: string;
  /** Like {@link seedCacheDust} but for the unshielded sub-wallet. */
  seedCacheUnshielded?: string;
  /**
   * Sync batch size for the shielded + dust sub-wallets. Defaults to
   * {@link DEFAULT_SYNC_BATCH_SIZE} (5000). Raise it to replay a long dust
   * history faster (more memory per batch); lower it on a memory-constrained
   * host. The SDK default of 10 OOMs on preprod's ~1M-event dust stream.
   */
  syncBatchSize?: number;
}

/**
 * Owned wallet handle: a built `MidnightWalletProvider` plus the
 * on-disk caches for its three sub-wallets. Acquire via {@link build}
 * and an `AsyncDisposableStack.use()`; call {@link saveCache} after
 * sync.
 */
export class WalletHandler implements AsyncDisposable {
  /** The underlying testkit-js wallet provider. */
  readonly provider: MidnightWalletProvider;
  /** The unshielded keystore the wallet was built with. */
  readonly unshieldedKeystore: UnshieldedKeystore;
  readonly #logger: Logger;
  readonly #cache: WalletCache;

  private constructor(
    provider: MidnightWalletProvider,
    keystore: UnshieldedKeystore,
    logger: Logger,
    cache: WalletCache,
  ) {
    this.provider = provider;
    this.unshieldedKeystore = keystore;
    this.#logger = logger;
    this.#cache = cache;
  }

  /**
   * Build a `MidnightWalletProvider` with three fixes over the bare
   * testkit-js builder:
   *  1. Tunes `additionalFeeOverhead` for non-mainnet wallet sizes.
   *  2. Routes mnemonic vs hex seed through the right derivation path
   *     (they derive *different* wallets from the same input).
   *  3. Restores all three sub-wallets from on-disk cache when present
   *     (saves the 30–60 min first-preprod sync).
   * Caller drives `provider.start()`; call {@link saveCache} post-sync.
   */
  static async build(
    logger: Logger,
    env: EnvironmentConfiguration,
    seed: WalletSeed,
    opts: WalletHandlerBuildOptions,
  ): Promise<WalletHandler> {
    const dustOptions: DustWalletOptions = {
      ...DEFAULT_DUST_OPTIONS,
      // testkit's 5e20 default exceeds a typical preview/preprod
      // wallet's ~3e15 dust, breaking fee balance. 5e14 keeps margin
      // without exceeding the balance on non-mainnet networks.
      additionalFeeOverhead:
        env.walletNetworkId === 'mainnet'
          ? DEFAULT_DUST_OPTIONS.additionalFeeOverhead
          : 500_000_000_000_000n,
    };

    const walletSeeds: WalletSeeds =
      seed.kind === 'mnemonic'
        ? WalletSeeds.fromMnemonic(seed.value)
        : WalletSeeds.fromMasterSeed(seed.value);

    // testkit-js doesn't export `mapEnvironmentToConfiguration` and
    // the `config` field isn't on the .d.ts. Cast through unknown.
    const builderForConfig = FluentWalletBuilder.forEnvironment(env);
    const config = (builderForConfig as unknown as { config: ConfigShape })
      .config;

    // Raise the sync batch size on the *shared* config so it applies to
    // every sub-wallet built off it: shielded and dust, fresh-sync and
    // cache-restore alike. `buildDustConfig` spreads this config, so the
    // restore path inherits it too. Setting it only on the fresh-build
    // path would be bypassed the moment an on-disk snapshot exists, which
    // is exactly when preprod's dust replay OOMs. See
    // {@link DEFAULT_SYNC_BATCH_SIZE} and OpenZeppelin/compact-tools#115.
    (config as { batchUpdates?: BatchUpdatesConfig }).batchUpdates = {
      size: opts.syncBatchSize ?? DEFAULT_SYNC_BATCH_SIZE,
      ...SYNC_BATCH_TIMING,
    };

    const unshieldedKeystore: UnshieldedKeystore = createKeystore(
      walletSeeds.unshielded,
      env.walletNetworkId as Parameters<typeof createKeystore>[1],
    );

    const cache = new WalletCache({
      logger,
      env,
      rootDir: opts.rootDir,
      shieldedSeed: walletSeeds.shielded,
      dustSeed: walletSeeds.dust,
      unshieldedSeed: walletSeeds.unshielded,
    });

    // Pre-warmed cache import: place the user-supplied state file at
    // the seed-derived `.states/` path so the existing restore path
    // picks it up. Mutual exclusion with `--no-cache` is a warn, not a
    // hard error — keeps the flag combinations cheap.
    if (opts.skipWalletCache === true) {
      if (
        opts.seedCacheShielded ||
        opts.seedCacheDust ||
        opts.seedCacheUnshielded
      ) {
        logger.warn(
          '--seed-cache-from-* is ignored under --no-cache (cache load is disabled)',
        );
      }
    } else {
      if (opts.seedCacheShielded) {
        cache.importSeedCache(opts.seedCacheShielded, 'shielded');
      }
      if (opts.seedCacheDust) {
        cache.importSeedCache(opts.seedCacheDust, 'dust');
      }
      if (opts.seedCacheUnshielded) {
        cache.importSeedCache(opts.seedCacheUnshielded, 'unshielded');
      }
    }

    const shieldedWallet = await cache.loadOrCreateShieldedWallet({
      config,
      seed: walletSeeds.shielded,
      skipCache: opts.skipWalletCache === true,
    });

    const unshieldedWallet = await cache.loadOrCreateUnshieldedWallet({
      config,
      keystore: unshieldedKeystore,
      skipCache: opts.skipWalletCache === true,
    });

    const dustWallet = await cache.loadOrCreateDustWallet({
      config,
      seed: walletSeeds.dust,
      dustOptions,
      skipCache: opts.skipWalletCache === true,
    });

    type CreateFacadeArgs = Parameters<typeof WalletFactory.createWalletFacade>;
    const walletFacade: WalletFacade = await WalletFactory.createWalletFacade(
      config as CreateFacadeArgs[0],
      shieldedWallet as CreateFacadeArgs[1],
      unshieldedWallet,
      dustWallet,
    );

    const provider = await MidnightWalletProvider.withWallet(
      logger,
      env,
      walletFacade,
      ZswapSecretKeys.fromSeed(walletSeeds.shielded),
      DustSecretKey.fromSeed(walletSeeds.dust),
      unshieldedKeystore as Parameters<
        typeof MidnightWalletProvider.withWallet
      >[5],
    );

    return new WalletHandler(provider, unshieldedKeystore, logger, cache);
  }

  /**
   * Snapshot all three sub-wallets to disk. Best-effort and independent
   * per sub-wallet. Shielded and dust are cached because they are slow
   * on first sync (shielded trial-decrypts every note; dust streams the
   * global unfiltered ledger event log). Unshielded is cached because
   * the sync gate waits on its progress, so an uncached one re-syncs
   * from genesis and dominates an otherwise-warm boot.
   */
  async saveCache(): Promise<void> {
    await this.#cache.save(this.provider.wallet);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.provider.stop();
    } catch (e) {
      this.#logger.warn({ err: formatError(e) }, 'Wallet stop failed');
    }
  }
}
