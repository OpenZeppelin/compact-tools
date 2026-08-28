import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DustSecretKey, ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';
import {
  DEFAULT_DUST_OPTIONS,
  DEFAULT_WALLET_STATE_DIRECTORY,
  type DustWalletOptions,
  type EnvironmentConfiguration,
  FluentWalletBuilder,
  MidnightWalletProvider,
  WalletFactory,
  WalletSaveStateProvider,
  WalletSeeds,
} from '@midnight-ntwrk/testkit-js';
import {
  DustWallet,
  type DustWalletAPI,
} from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import type { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import type { ShieldedWalletAPI } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  createKeystore,
  type UnshieldedKeystore,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import type { Logger } from 'pino';
import { WalletError } from '../errors.ts';
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
 * was validated at ~146 MB peak, ~1000 events/sec. Harmless on the
 * upstream-fixed 4.1.0, which no longer needs the workaround.
 */
const DEFAULT_SYNC_BATCH_SIZE = 5000;

/** `timeout`/`spacing` companions to the batch size; left at the validated values. */
const SYNC_BATCH_TIMING = { timeout: 1, spacing: 4 } as const;

export interface WalletHandlerBuildOptions {
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
  /**
   * Sync batch size for the shielded + dust sub-wallets. Defaults to
   * {@link DEFAULT_SYNC_BATCH_SIZE} (5000). Raise it to replay a long dust
   * history faster (more memory per batch); lower it on a memory-constrained
   * host. The SDK default of 10 OOMs on preprod's ~1M-event dust stream.
   */
  syncBatchSize?: number;
}

/**
 * Owned wallet handle: a built `MidnightWalletProvider` plus its
 * shielded + dust on-disk caches. Acquire via {@link build} and an
 * `AsyncDisposableStack.use()`; call {@link saveCache} after sync.
 */
export class WalletHandler implements AsyncDisposable {
  /** The underlying testkit-js wallet provider. */
  readonly provider: MidnightWalletProvider;
  /** The unshielded keystore the wallet was built with. */
  readonly unshieldedKeystore: UnshieldedKeystore;
  readonly #logger: Logger;
  readonly #shieldedCacheFilePath: string;
  readonly #dustCacheFilePath: string;

  private constructor(
    provider: MidnightWalletProvider,
    keystore: UnshieldedKeystore,
    logger: Logger,
    shieldedCacheFilePath: string,
    dustCacheFilePath: string,
  ) {
    this.provider = provider;
    this.unshieldedKeystore = keystore;
    this.#logger = logger;
    this.#shieldedCacheFilePath = shieldedCacheFilePath;
    this.#dustCacheFilePath = dustCacheFilePath;
  }

  /**
   * Build a `MidnightWalletProvider` with three fixes over the bare
   * testkit-js builder:
   *  1. Tunes `additionalFeeOverhead` for non-mainnet wallet sizes.
   *  2. Routes mnemonic vs hex seed through the right derivation path
   *     (they derive *different* wallets from the same input).
   *  3. Restores the shielded + dust sub-wallets from on-disk cache
   *     when present (saves the 30–60 min first-preprod sync).
   * Caller drives `provider.start()`; call {@link saveCache} post-sync.
   */
  static async build(
    logger: Logger,
    env: EnvironmentConfiguration,
    seed: WalletSeed,
    opts: WalletHandlerBuildOptions = {},
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

    const shieldedCacheFilePath = computeCacheFilePath(
      env,
      walletSeeds.shielded,
      'shielded',
    );
    const dustCacheFilePath = computeCacheFilePath(
      env,
      walletSeeds.dust,
      'dust',
    );

    // Pre-warmed cache import: place the user-supplied state file at
    // the seed-derived `.states/` path so the existing restore path
    // picks it up. Mutual exclusion with `--no-cache` is a warn, not a
    // hard error — keeps the flag combinations cheap.
    if (opts.skipWalletCache === true) {
      if (opts.seedCacheShielded || opts.seedCacheDust) {
        logger.warn(
          '--seed-cache-from-* is ignored under --no-cache (cache load is disabled)',
        );
      }
    } else {
      if (opts.seedCacheShielded) {
        importSeedCache(
          logger,
          opts.seedCacheShielded,
          shieldedCacheFilePath,
          'shielded',
        );
      }
      if (opts.seedCacheDust) {
        importSeedCache(logger, opts.seedCacheDust, dustCacheFilePath, 'dust');
      }
    }

    const shieldedWallet = await loadOrCreateShieldedWallet({
      logger,
      config,
      seed: walletSeeds.shielded,
      cacheFilePath: shieldedCacheFilePath,
      skipCache: opts.skipWalletCache === true,
    });

    const unshieldedWallet = WalletFactory.createUnshieldedWallet(
      config as Parameters<typeof WalletFactory.createUnshieldedWallet>[0],
      unshieldedKeystore as Parameters<
        typeof WalletFactory.createUnshieldedWallet
      >[1],
    );

    const dustWallet = await loadOrCreateDustWallet({
      logger,
      config,
      seed: walletSeeds.dust,
      dustOptions,
      cacheFilePath: dustCacheFilePath,
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

    return new WalletHandler(
      provider,
      unshieldedKeystore,
      logger,
      shieldedCacheFilePath,
      dustCacheFilePath,
    );
  }

  /**
   * Snapshot the shielded + dust sub-wallets to disk. Best-effort and
   * independent per sub-wallet. Both are cached because on real
   * networks both are slow on first sync (shielded trial-decrypts every
   * note; dust streams the global unfiltered ledger event log).
   */
  async saveCache(): Promise<void> {
    await Promise.allSettled([
      this.#saveSubWalletCache(
        this.#shieldedCacheFilePath,
        this.provider.wallet.shielded,
        'shielded',
      ),
      this.#saveSubWalletCache(
        this.#dustCacheFilePath,
        this.provider.wallet.dust,
        'dust',
      ),
    ]);
  }

  async #saveSubWalletCache(
    filePath: string,
    subWallet: unknown,
    label: string,
  ): Promise<void> {
    try {
      const dir = pathDir(filePath);
      const filename = pathBase(filePath);
      // `seed` param only feeds the default filename; we pass an
      // explicit one, so the empty string is fine.
      const saver = new WalletSaveStateProvider(
        this.#logger,
        '',
        dir,
        filename,
      );
      await saver.save(subWallet as Parameters<typeof saver.save>[0]);
      // WalletSaveStateProvider writes at the process umask and offers no
      // mode control, so tighten the snapshot after the fact.
      chmodSync(filePath, 0o600);
    } catch (e) {
      this.#logger.warn(
        { err: (e as Error).message, label, filePath },
        'Wallet sub-wallet cache save failed; continuing',
      );
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.provider.stop();
    } catch (e) {
      this.#logger.warn({ err: (e as Error).message }, 'Wallet stop failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Opaque testkit-js `FluentWalletBuilder.config` (not exported by testkit). */
type ConfigShape = unknown;

/**
 * Drop a user-supplied wallet-state file into `.states/` under the
 * seed-derived filename so the existing restore path picks it up.
 * Detects gzip via magic bytes (`0x1f 0x8b`); raw JSON is gzipped on
 * the way in. Throws {@link WalletError} on read failure so a bad path
 * fails fast instead of silently doing a cold sync from genesis.
 *
 * Safety guarantees:
 *  1. **Source is read-only.** Only `readFileSync` touches `srcPath`.
 *  2. **Backup is preserved forever.** If the target `.gz` already
 *     exists, it is `copyFileSync`'d to `<target>.bak` *before* any
 *     write — never deleted, never overwritten by this helper. A user
 *     who hits a bad-format import can roll back with
 *     `mv <target>.bak <target>` and re-run.
 *  3. **Write is atomic.** New bytes land in `<target>.tmp` first,
 *     then `rename(2)` over the final path. POSIX rename is atomic
 *     within the same filesystem, so a mid-write crash can never leave
 *     the existing cache half-overwritten. A stale `.tmp` left by a
 *     failed rename is harmless (cache load only scans `.gz`) and gets
 *     overwritten by the next import attempt.
 */
function importSeedCache(
  logger: Logger,
  srcPath: string,
  targetPath: string,
  kind: 'shielded' | 'dust',
): void {
  const absoluteSrc = resolve(process.cwd(), srcPath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(absoluteSrc);
  } catch (e) {
    throw new WalletError(
      `--seed-cache-from-${kind}: cannot read ${absoluteSrc}: ${(e as Error).message}`,
    );
  }
  const isGzipped = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  const payload = isGzipped ? bytes : gzipSync(bytes);
  const backupPath = `${targetPath}.bak`;
  const tempPath = `${targetPath}.tmp`;
  mkdirSync(pathDir(targetPath), { recursive: true });
  // Preserve the previous cache forever as `<target>.bak` so a
  // bad-format import is always recoverable by hand. We use copy (not
  // rename) so the live `<target>` keeps its bytes throughout the
  // window before the atomic rename below.
  const backedUp = existsSync(targetPath);
  if (backedUp) {
    copyFileSync(targetPath, backupPath);
  }
  // 0o600: a wallet state snapshot exposes the full UTXO set and every
  // derived address. Set at create time so the bytes are never group- or
  // world-readable, not even between write and rename.
  writeFileSync(tempPath, payload, { mode: 0o600 });
  renameSync(tempPath, targetPath);
  logger.info(
    `Imported ${kind} cache: ${absoluteSrc} → ${targetPath}${
      backedUp ? ` (previous cache backed up to ${backupPath})` : ''
    }`,
  );
}

/**
 * `<network>-<sha256(seed)[:16]>-<kind>.gz`. Per-kind suffix prevents
 * shielded/dust cross-load (different state schemas). Don't reuse
 * testkit's helper: it embeds the seed verbatim and gates the
 * network on env vars instead of runtime ID.
 */
function computeCacheFilePath(
  env: EnvironmentConfiguration,
  seed: Uint8Array,
  kind: 'shielded' | 'dust',
): string {
  const seedHash = createHash('sha256').update(seed).digest('hex').slice(0, 16);
  const filename = `${env.walletNetworkId}-${seedHash}-${kind}.gz`;
  return resolve(process.cwd(), DEFAULT_WALLET_STATE_DIRECTORY, filename);
}

/**
 * Restore dust wallet from cache, else build fresh. Routes through
 * `DustWallet(config).restore(...)` because testkit doesn't expose a
 * `WalletFactory.restoreDustWallet`. Caching turns preprod's 1 h+
 * first-run dust sync into seconds on subsequent boots.
 */
async function loadOrCreateDustWallet(args: {
  logger: Logger;
  config: ConfigShape;
  seed: Uint8Array;
  dustOptions: DustWalletOptions;
  cacheFilePath: string;
  skipCache: boolean;
}): Promise<DustWalletAPI> {
  const { logger, config, seed, dustOptions, cacheFilePath, skipCache } = args;

  if (!skipCache && existsSync(cacheFilePath)) {
    try {
      const dir = pathDir(cacheFilePath);
      const filename = pathBase(cacheFilePath);
      const loader = new WalletSaveStateProvider(logger, '', dir, filename);
      const serializedState = await loader.load();
      // `costParameters` is runtime state on the builder, not baked
      // into the snapshot. Re-apply `dustOptions` so the restored
      // wallet honours our `additionalFeeOverhead` override.
      const dustConfig = buildDustConfig(config, dustOptions);
      const dustClass = DustWallet(
        dustConfig as Parameters<typeof DustWallet>[0],
      );
      const restored = dustClass.restore(serializedState);
      logger.info(`Restored dust wallet state from ${cacheFilePath}`);
      return restored as unknown as DustWalletAPI;
    } catch (e) {
      logger.warn(
        { err: (e as Error).message, cacheFilePath },
        'Dust wallet cache restore failed; falling back to fresh sync',
      );
    }
  } else if (skipCache) {
    logger.info('Dust wallet cache disabled (--no-cache); doing fresh sync');
  }

  return WalletFactory.createDustWallet(
    config as Parameters<typeof WalletFactory.createDustWallet>[0],
    seed,
    dustOptions,
  );
}

async function loadOrCreateShieldedWallet(args: {
  logger: Logger;
  config: ConfigShape;
  seed: Uint8Array;
  cacheFilePath: string;
  skipCache: boolean;
}): Promise<ShieldedWalletAPI> {
  const { logger, config, seed, cacheFilePath, skipCache } = args;

  if (!skipCache && existsSync(cacheFilePath)) {
    try {
      const dir = pathDir(cacheFilePath);
      const filename = pathBase(cacheFilePath);
      const loader = new WalletSaveStateProvider(logger, '', dir, filename);
      const serializedState = await loader.load();
      const restored = await WalletFactory.restoreShieldedWallet(
        config as Parameters<typeof WalletFactory.restoreShieldedWallet>[0],
        serializedState,
      );
      logger.info(`Restored wallet state from ${cacheFilePath}`);
      return restored as ShieldedWalletAPI;
    } catch (e) {
      logger.warn(
        { err: (e as Error).message, cacheFilePath },
        'Wallet cache restore failed; falling back to fresh sync',
      );
    }
  } else if (skipCache) {
    logger.info('Wallet cache disabled (--no-cache); doing fresh sync');
  }

  return WalletFactory.createShieldedWallet(
    config as Parameters<typeof WalletFactory.createShieldedWallet>[0],
    seed,
  ) as ShieldedWalletAPI;
}

/** Layer `dustOptions` onto the base config so cache-restored wallets honour `additionalFeeOverhead`. */
function buildDustConfig(
  config: ConfigShape,
  dustOptions: DustWalletOptions,
): ConfigShape {
  return {
    ...(config as Record<string, unknown>),
    costParameters: {
      ledgerParams: dustOptions.ledgerParams,
      additionalFeeOverhead: dustOptions.additionalFeeOverhead,
      feeBlocksMargin: dustOptions.feeBlocksMargin,
    },
  } as ConfigShape;
}

function pathDir(p: string): string {
  return dirname(p);
}

function pathBase(p: string): string {
  return basename(p);
}
