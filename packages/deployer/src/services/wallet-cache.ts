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
import {
  DEFAULT_WALLET_STATE_DIRECTORY,
  type DustWalletOptions,
  type EnvironmentConfiguration,
  WalletFactory,
  WalletSaveStateProvider,
} from '@midnight-ntwrk/testkit-js';
import {
  DustWallet,
  type DustWalletAPI,
} from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import type { ShieldedWalletAPI } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  type UnshieldedKeystore,
  UnshieldedWallet,
  type UnshieldedWalletAPI,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import type { Logger } from 'pino';
import { WalletError } from '../errors.ts';
import { formatError } from './error-format.ts';

/** Opaque testkit-js `FluentWalletBuilder.config` (not exported by testkit). */
export type ConfigShape = unknown;

/** Sub-wallet a snapshot belongs to. Snapshots are not interchangeable across kinds. */
export type SubWalletKind = 'shielded' | 'dust' | 'unshielded';

export interface WalletCacheOptions {
  logger: Logger;
  env: EnvironmentConfiguration;
  /**
   * Directory `compact.toml` was loaded from. `.states/` hangs off it so
   * the cache belongs to the project, not to whichever directory the
   * user happened to run `compact-deploy` from.
   */
  rootDir: string;
  shieldedSeed: Uint8Array;
  dustSeed: Uint8Array;
  unshieldedSeed: Uint8Array;
}

/**
 * On-disk persistence for the three sub-wallets: seed-derived `.states/`
 * paths, pre-warmed cache import, restore-or-build, and post-sync
 * snapshots.
 *
 * Shielded and dust are cached because they are slow to sync on real
 * networks (shielded trial-decrypts every note; dust streams the global
 * unfiltered ledger event log). Unshielded is cheap to scan but the sync
 * gate waits on its progress too, so an uncached unshielded sub-wallet
 * re-syncs from genesis and becomes the long pole on every cached boot.
 */
export class WalletCache {
  /** Seed-derived `.states/` path for the shielded snapshot. */
  readonly shieldedCacheFilePath: string;
  /** Seed-derived `.states/` path for the dust snapshot. */
  readonly dustCacheFilePath: string;
  /** Seed-derived `.states/` path for the unshielded snapshot. */
  readonly unshieldedCacheFilePath: string;
  readonly #logger: Logger;

  constructor(opts: WalletCacheOptions) {
    this.#logger = opts.logger;
    this.shieldedCacheFilePath = computeCacheFilePath(
      opts.rootDir,
      opts.env,
      opts.shieldedSeed,
      'shielded',
    );
    this.dustCacheFilePath = computeCacheFilePath(
      opts.rootDir,
      opts.env,
      opts.dustSeed,
      'dust',
    );
    this.unshieldedCacheFilePath = computeCacheFilePath(
      opts.rootDir,
      opts.env,
      opts.unshieldedSeed,
      'unshielded',
    );
  }

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
  importSeedCache(srcPath: string, kind: SubWalletKind): void {
    const targetPath = {
      shielded: this.shieldedCacheFilePath,
      dust: this.dustCacheFilePath,
      unshielded: this.unshieldedCacheFilePath,
    }[kind];
    // CWD-relative on purpose: `srcPath` is what the user typed after
    // `--seed-cache-from-*`, usually shell-completed against the
    // directory they are standing in. `rootDir` governs where the
    // deployer *puts* its own files, not how it reads the user's.
    const absoluteSrc = resolve(process.cwd(), srcPath);
    let bytes: Buffer;
    try {
      bytes = readFileSync(absoluteSrc);
    } catch (e) {
      throw new WalletError(
        `--seed-cache-from-${kind}: cannot read ${absoluteSrc}: ${(e as Error).message}`,
      );
    }
    const isGzipped =
      bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
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
    this.#logger.info(
      `Imported ${kind} cache: ${absoluteSrc} → ${targetPath}${
        backedUp ? ` (previous cache backed up to ${backupPath})` : ''
      }`,
    );
  }

  async loadOrCreateShieldedWallet(args: {
    config: ConfigShape;
    seed: Uint8Array;
    skipCache: boolean;
  }): Promise<ShieldedWalletAPI> {
    const { config, seed, skipCache } = args;
    const logger = this.#logger;
    const cacheFilePath = this.shieldedCacheFilePath;

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
          { err: formatError(e), cacheFilePath },
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

  /**
   * Restore dust wallet from cache, else build fresh. Routes through
   * `DustWallet(config).restore(...)` because testkit doesn't expose a
   * `WalletFactory.restoreDustWallet`. Caching turns preprod's 1 h+
   * first-run dust sync into seconds on subsequent boots.
   */
  async loadOrCreateDustWallet(args: {
    config: ConfigShape;
    seed: Uint8Array;
    dustOptions: DustWalletOptions;
    skipCache: boolean;
  }): Promise<DustWalletAPI> {
    const { config, seed, dustOptions, skipCache } = args;
    const logger = this.#logger;
    const cacheFilePath = this.dustCacheFilePath;

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
          { err: formatError(e), cacheFilePath },
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

  /**
   * Restore the unshielded wallet from cache, else build fresh. Routes
   * through `UnshieldedWallet(config).restore(...)` because testkit
   * doesn't expose a `WalletFactory.restoreUnshieldedWallet`. The
   * snapshot carries the public key, so no keystore is needed to
   * rehydrate; the keystore is only used on the fresh path.
   */
  async loadOrCreateUnshieldedWallet(args: {
    config: ConfigShape;
    keystore: UnshieldedKeystore;
    skipCache: boolean;
  }): Promise<UnshieldedWalletAPI> {
    const { config, keystore, skipCache } = args;
    const logger = this.#logger;
    const cacheFilePath = this.unshieldedCacheFilePath;

    if (!skipCache && existsSync(cacheFilePath)) {
      try {
        const dir = pathDir(cacheFilePath);
        const filename = pathBase(cacheFilePath);
        const loader = new WalletSaveStateProvider(logger, '', dir, filename);
        const serializedState = await loader.load();
        const unshieldedClass = UnshieldedWallet(
          config as Parameters<typeof UnshieldedWallet>[0],
        );
        const restored = unshieldedClass.restore(serializedState);
        logger.info(`Restored unshielded wallet state from ${cacheFilePath}`);
        return restored;
      } catch (e) {
        logger.warn(
          { err: formatError(e), cacheFilePath },
          'Unshielded wallet cache restore failed; falling back to fresh sync',
        );
      }
    } else if (skipCache) {
      logger.info(
        'Unshielded wallet cache disabled (--no-cache); doing fresh sync',
      );
    }

    return WalletFactory.createUnshieldedWallet(
      config as Parameters<typeof WalletFactory.createUnshieldedWallet>[0],
      keystore as Parameters<typeof WalletFactory.createUnshieldedWallet>[1],
    );
  }

  /**
   * Snapshot every sub-wallet to disk. Best-effort and independent per
   * sub-wallet: one failure never blocks the others.
   */
  async save(wallet: {
    shielded: unknown;
    dust: unknown;
    unshielded: unknown;
  }): Promise<void> {
    await Promise.allSettled([
      this.#saveSubWalletCache(
        this.shieldedCacheFilePath,
        wallet.shielded,
        'shielded',
      ),
      this.#saveSubWalletCache(this.dustCacheFilePath, wallet.dust, 'dust'),
      this.#saveSubWalletCache(
        this.unshieldedCacheFilePath,
        wallet.unshielded,
        'unshielded',
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
        { err: formatError(e), label, filePath },
        'Wallet sub-wallet cache save failed; continuing',
      );
    }
  }
}

/**
 * `<rootDir>/.states/<network>-<sha256(seed)[:16]>-<kind>.gz`. Per-kind
 * suffix prevents cross-loading one sub-wallet's snapshot into another
 * (different state schemas). Don't reuse testkit's helper: it embeds the
 * seed verbatim, resolves against the CWD, and gates the network on env
 * vars instead of runtime ID.
 */
function computeCacheFilePath(
  rootDir: string,
  env: EnvironmentConfiguration,
  seed: Uint8Array,
  kind: SubWalletKind,
): string {
  const seedHash = createHash('sha256').update(seed).digest('hex').slice(0, 16);
  const filename = `${env.walletNetworkId}-${seedHash}-${kind}.gz`;
  return resolve(rootDir, DEFAULT_WALLET_STATE_DIRECTORY, filename);
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
