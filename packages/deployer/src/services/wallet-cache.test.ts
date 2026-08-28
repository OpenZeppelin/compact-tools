import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import {
  WalletFactory,
  WalletSaveStateProvider,
} from '@midnight-ntwrk/testkit-js';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { UnshieldedWallet } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletCache } from './wallet-cache.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => Buffer.alloc(0)),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    copyFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  };
});

vi.mock('@midnight-ntwrk/testkit-js', () => ({
  DEFAULT_WALLET_STATE_DIRECTORY: './.states',
  WalletFactory: {
    createShieldedWallet: vi.fn(() => ({ tag: 'shielded-fresh' })),
    createDustWallet: vi.fn(() => ({ tag: 'dust-fresh' })),
    createUnshieldedWallet: vi.fn(() => ({ tag: 'unshielded-fresh' })),
    restoreShieldedWallet: vi.fn(async () => ({ tag: 'shielded-restored' })),
  },
  WalletSaveStateProvider: vi.fn(),
}));

vi.mock('@midnight-ntwrk/wallet-sdk-dust-wallet', () => ({
  DustWallet: vi.fn(() => ({
    restore: vi.fn(() => ({ tag: 'dust-restored' })),
  })),
}));

vi.mock('@midnight-ntwrk/wallet-sdk-unshielded-wallet', () => ({
  UnshieldedWallet: vi.fn(() => ({
    restore: vi.fn(() => ({ tag: 'unshielded-restored' })),
  })),
}));

/** Pino-shaped logger whose methods are spies, freshly built per test. */
function spyLogger(): Logger {
  const logger: Record<string, unknown> = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    level: 'silent',
  };
  logger.child = (): Logger => spyLogger();
  return logger as unknown as Logger;
}

function fakeEnv(
  walletNetworkId: EnvironmentConfiguration['walletNetworkId'] = 'testnet',
): EnvironmentConfiguration {
  return { walletNetworkId } as unknown as EnvironmentConfiguration;
}

const DUST_OPTIONS = {
  additionalFeeOverhead: 1000n,
  ledgerParams: { tag: 'ledger-params' },
  feeBlocksMargin: 7,
} as unknown as Parameters<
  WalletCache['loadOrCreateDustWallet']
>[0]['dustOptions'];

/** Stub the save-state provider's `load`/`save` for one test. */
function wireSaveStateProvider(impl: { load?: unknown; save?: unknown }): void {
  vi.mocked(WalletSaveStateProvider).mockImplementation(function (
    this: object,
  ) {
    Object.assign(this, {
      load: impl.load ?? vi.fn(async () => 'serialized-state'),
      save: impl.save ?? vi.fn(async () => undefined),
    });
  } as unknown as new (
    ...args: unknown[]
  ) => InstanceType<typeof WalletSaveStateProvider>);
}

describe('WalletCache', () => {
  let logger: Logger;

  function makeCache(env = fakeEnv()): WalletCache {
    return new WalletCache({
      logger,
      env,
      shieldedSeed: new Uint8Array(32).fill(0x11),
      dustSeed: new Uint8Array(32).fill(0x33),
      unshieldedSeed: new Uint8Array(32).fill(0x22),
    });
  }

  beforeEach(() => {
    logger = spyLogger();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('cache file paths', () => {
    it('should derive per-kind seed-hashed paths under .states/', () => {
      const cache = makeCache(fakeEnv('preview'));
      expect(cache.shieldedCacheFilePath).toMatch(
        /\.states\/preview-[0-9a-f]{16}-shielded\.gz$/,
      );
      expect(cache.dustCacheFilePath).toMatch(
        /\.states\/preview-[0-9a-f]{16}-dust\.gz$/,
      );
      expect(cache.unshieldedCacheFilePath).toMatch(
        /\.states\/preview-[0-9a-f]{16}-unshielded\.gz$/,
      );
    });

    it('should give every sub-wallet a distinct filename for its distinct seed', () => {
      const cache = makeCache();
      const paths = [
        cache.shieldedCacheFilePath,
        cache.dustCacheFilePath,
        cache.unshieldedCacheFilePath,
      ];
      expect(new Set(paths).size).toBe(3);
    });
  });

  describe('importSeedCache', () => {
    it('should gzip a raw-JSON source into the seed-derived path', () => {
      vi.mocked(readFileSync).mockReturnValue(
        Buffer.from('{"state":"raw-json"}', 'utf8'),
      );
      makeCache(fakeEnv('preview')).importSeedCache(
        '/path/to/state.json',
        'dust',
      );
      // Atomic write: payload lands in `<target>.tmp`, then rename to
      // `<target>`. Asserts both halves so a future regression that
      // skips the rename (or writes directly to target) fails loudly.
      expect(writeFileSync).toHaveBeenCalled();
      const [tempPath, payload] = vi.mocked(writeFileSync).mock.calls[0] ?? [];
      expect(String(tempPath)).toMatch(/preview-[0-9a-f]{16}-dust\.gz\.tmp$/);
      // Payload was raw → must be gzipped on the way in (magic bytes).
      const payloadBuf = payload as Buffer;
      expect(payloadBuf[0]).toBe(0x1f);
      expect(payloadBuf[1]).toBe(0x8b);
      // rename(2) is atomic on POSIX within the same filesystem.
      const [renameFrom, renameTo] = vi.mocked(renameSync).mock.calls[0] ?? [];
      expect(String(renameFrom)).toBe(String(tempPath));
      expect(String(renameTo)).toMatch(/preview-[0-9a-f]{16}-dust\.gz$/);
    });

    it('should pass a gzipped source through unchanged (no double-gzip)', () => {
      const gzipped = gzipSync(Buffer.from('{"state":"raw-json"}', 'utf8'));
      vi.mocked(readFileSync).mockReturnValue(gzipped);
      makeCache().importSeedCache('/path/to/state.gz', 'dust');
      expect(vi.mocked(writeFileSync).mock.calls[0]?.[1]).toEqual(gzipped);
    });

    it('should write the imported cache with mode 0o600', () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      makeCache().importSeedCache('/state.json', 'dust');
      // Owner-only from creation: the snapshot exposes the full UTXO set.
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.anything(),
        { mode: 0o600 },
      );
    });

    it('should ensure the .states/ directory exists before writing', () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      makeCache().importSeedCache('/state.json', 'dust');
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ recursive: true }),
      );
    });

    it('should throw WalletError when the source file is missing', () => {
      vi.mocked(readFileSync).mockImplementationOnce(() => {
        throw new Error('ENOENT: no such file');
      });
      expect(() =>
        makeCache().importSeedCache('/missing.json', 'dust'),
      ).toThrow(/--seed-cache-from-dust:.*missing\.json/);
    });

    it('should back up an existing target cache to <target>.bak before overwriting', () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      vi.mocked(existsSync).mockReturnValue(true);
      makeCache().importSeedCache('/state.json', 'dust');
      // copyFileSync MUST be called with (target, target.bak) so the
      // previous cache bytes are preserved forever. If this assertion
      // breaks, the safety net we promised the user is gone.
      expect(copyFileSync).toHaveBeenCalledTimes(1);
      const [src, dest] = vi.mocked(copyFileSync).mock.calls[0] ?? [];
      expect(String(src)).toMatch(/-dust\.gz$/);
      expect(String(dest)).toBe(`${String(src)}.bak`);
      const sawBackupLog = vi
        .mocked(logger.info)
        .mock.calls.some((c) =>
          String(c[0]).includes('previous cache backed up to'),
        );
      expect(sawBackupLog).toBe(true);
    });

    it('should NOT create a .bak when the target cache does not already exist', () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      vi.mocked(existsSync).mockReturnValue(false);
      makeCache().importSeedCache('/state.json', 'dust');
      expect(copyFileSync).not.toHaveBeenCalled();
    });

    it('should route a shielded import to the matching -shielded.gz path', () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      makeCache(fakeEnv('preview')).importSeedCache('/state.json', 'shielded');
      const renameTo = vi.mocked(renameSync).mock.calls[0]?.[1];
      expect(String(renameTo)).toMatch(/preview-[0-9a-f]{16}-shielded\.gz$/);
    });

    it('should route an unshielded import to the matching -unshielded.gz path', () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      makeCache(fakeEnv('preview')).importSeedCache(
        '/state.json',
        'unshielded',
      );
      const renameTo = vi.mocked(renameSync).mock.calls[0]?.[1];
      expect(String(renameTo)).toMatch(/preview-[0-9a-f]{16}-unshielded\.gz$/);
    });
  });

  describe('loadOrCreateShieldedWallet', () => {
    const args = {
      config: { tag: 'config' },
      seed: new Uint8Array(32).fill(0x11),
      skipCache: false,
    };

    it('should build fresh when no cache file exists', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const wallet = await makeCache().loadOrCreateShieldedWallet(args);
      expect(wallet).toEqual({ tag: 'shielded-fresh' });
      expect(WalletFactory.restoreShieldedWallet).not.toHaveBeenCalled();
    });

    it('should restore from cache when the file exists', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      wireSaveStateProvider({});
      const wallet = await makeCache().loadOrCreateShieldedWallet(args);
      expect(WalletFactory.restoreShieldedWallet).toHaveBeenCalledWith(
        args.config,
        'serialized-state',
      );
      expect(wallet).toEqual({ tag: 'shielded-restored' });
      expect(WalletFactory.createShieldedWallet).not.toHaveBeenCalled();
    });

    it('should skip the cache entirely when skipCache is set', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await makeCache().loadOrCreateShieldedWallet({
        ...args,
        skipCache: true,
      });
      expect(WalletFactory.restoreShieldedWallet).not.toHaveBeenCalled();
      expect(WalletFactory.createShieldedWallet).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        'Wallet cache disabled (--no-cache); doing fresh sync',
      );
    });

    it('should fall back to a fresh build when restore throws', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      wireSaveStateProvider({
        load: vi.fn(async () => {
          throw new Error('corrupt');
        }),
      });
      await makeCache().loadOrCreateShieldedWallet(args);
      expect(WalletFactory.createShieldedWallet).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'corrupt' }),
        expect.stringContaining('Wallet cache restore failed'),
      );
    });
  });

  describe('loadOrCreateDustWallet', () => {
    const args = {
      config: { tag: 'config' },
      seed: new Uint8Array(32).fill(0x33),
      dustOptions: DUST_OPTIONS,
      skipCache: false,
    };

    it('should build fresh when no cache file exists', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const wallet = await makeCache().loadOrCreateDustWallet(args);
      expect(wallet).toEqual({ tag: 'dust-fresh' });
      expect(DustWallet).not.toHaveBeenCalled();
    });

    it('should restore from cache and re-apply the dust cost parameters', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      wireSaveStateProvider({});
      const wallet = await makeCache().loadOrCreateDustWallet(args);
      expect(wallet).toEqual({ tag: 'dust-restored' });
      // `costParameters` is not baked into the snapshot, so the restored
      // wallet only honours our `additionalFeeOverhead` if the config the
      // DustWallet class is built from carries it.
      expect(DustWallet).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: 'config',
          costParameters: {
            ledgerParams: DUST_OPTIONS.ledgerParams,
            additionalFeeOverhead: DUST_OPTIONS.additionalFeeOverhead,
            feeBlocksMargin: DUST_OPTIONS.feeBlocksMargin,
          },
        }),
      );
      expect(WalletFactory.createDustWallet).not.toHaveBeenCalled();
    });

    it('should skip the cache entirely when skipCache is set', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await makeCache().loadOrCreateDustWallet({ ...args, skipCache: true });
      expect(DustWallet).not.toHaveBeenCalled();
      expect(WalletFactory.createDustWallet).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        'Dust wallet cache disabled (--no-cache); doing fresh sync',
      );
    });

    it('should fall back to a fresh build when restore throws', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      wireSaveStateProvider({
        load: vi.fn(async () => {
          throw new Error('corrupt-dust');
        }),
      });
      await makeCache().loadOrCreateDustWallet(args);
      expect(WalletFactory.createDustWallet).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'corrupt-dust' }),
        expect.stringContaining('Dust wallet cache restore failed'),
      );
    });
  });

  describe('loadOrCreateUnshieldedWallet', () => {
    const args = {
      config: { tag: 'config' },
      keystore: { tag: 'keystore' } as unknown as Parameters<
        WalletCache['loadOrCreateUnshieldedWallet']
      >[0]['keystore'],
      skipCache: false,
    };

    it('should build fresh from the keystore when no cache file exists', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      const wallet = await makeCache().loadOrCreateUnshieldedWallet(args);
      expect(wallet).toEqual({ tag: 'unshielded-fresh' });
      expect(WalletFactory.createUnshieldedWallet).toHaveBeenCalledWith(
        args.config,
        args.keystore,
      );
      expect(UnshieldedWallet).not.toHaveBeenCalled();
    });

    it('should restore from cache without consulting the keystore', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      wireSaveStateProvider({});
      const wallet = await makeCache().loadOrCreateUnshieldedWallet(args);
      expect(wallet).toEqual({ tag: 'unshielded-restored' });
      // The snapshot carries the public key, so the restored wallet is
      // built from the config alone.
      expect(UnshieldedWallet).toHaveBeenCalledWith(args.config);
      expect(WalletFactory.createUnshieldedWallet).not.toHaveBeenCalled();
    });

    it('should skip the cache entirely when skipCache is set', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      await makeCache().loadOrCreateUnshieldedWallet({
        ...args,
        skipCache: true,
      });
      expect(UnshieldedWallet).not.toHaveBeenCalled();
      expect(WalletFactory.createUnshieldedWallet).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        'Unshielded wallet cache disabled (--no-cache); doing fresh sync',
      );
    });

    it('should fall back to a fresh build when restore throws', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      wireSaveStateProvider({
        load: vi.fn(async () => {
          throw new Error('corrupt-unshielded');
        }),
      });
      await makeCache().loadOrCreateUnshieldedWallet(args);
      expect(WalletFactory.createUnshieldedWallet).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'corrupt-unshielded' }),
        expect.stringContaining('Unshielded wallet cache restore failed'),
      );
    });
  });

  describe('save', () => {
    it('should snapshot all three sub-wallets and tighten them to 0o600', async () => {
      const save = vi.fn(async () => undefined);
      wireSaveStateProvider({ save });
      const cache = makeCache();
      await cache.save({
        shielded: { tag: 'sub-shielded' },
        dust: 'sub-dust',
        unshielded: 'sub-unshielded',
      });
      expect(save).toHaveBeenCalledWith({ tag: 'sub-shielded' });
      expect(save).toHaveBeenCalledWith('sub-dust');
      expect(save).toHaveBeenCalledWith('sub-unshielded');
      // WalletSaveStateProvider writes at the umask; the snapshot must end
      // up owner-only.
      expect(chmodSync).toHaveBeenCalledWith(
        cache.shieldedCacheFilePath,
        0o600,
      );
      expect(chmodSync).toHaveBeenCalledWith(cache.dustCacheFilePath, 0o600);
      expect(chmodSync).toHaveBeenCalledWith(
        cache.unshieldedCacheFilePath,
        0o600,
      );
    });

    it('should swallow a per-sub-wallet save failure with a warn log', async () => {
      wireSaveStateProvider({
        save: vi.fn(async () => {
          throw new Error('disk-full');
        }),
      });
      await expect(
        makeCache().save({ shielded: {}, dust: {}, unshielded: {} }),
      ).resolves.toBeUndefined();
      for (const label of ['shielded', 'dust', 'unshielded']) {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ err: 'disk-full', label }),
          'Wallet sub-wallet cache save failed; continuing',
        );
      }
    });

    it('should keep snapshotting the other sub-wallets when one fails', async () => {
      const save = vi.fn(async (sub: unknown) => {
        if (sub === 'sub-dust') throw new Error('disk-full');
      });
      wireSaveStateProvider({ save });
      const cache = makeCache();
      await cache.save({
        shielded: 'sub-shielded',
        dust: 'sub-dust',
        unshielded: 'sub-unshielded',
      });
      // allSettled, not all: the dust rejection must not cancel the two
      // siblings' snapshots.
      expect(save).toHaveBeenCalledTimes(3);
      expect(chmodSync).toHaveBeenCalledWith(
        cache.shieldedCacheFilePath,
        0o600,
      );
      expect(chmodSync).toHaveBeenCalledWith(
        cache.unshieldedCacheFilePath,
        0o600,
      );
      expect(chmodSync).not.toHaveBeenCalledWith(
        cache.dustCacheFilePath,
        0o600,
      );
    });
  });
});
