import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { gzipSync } from 'node:zlib';
import type {
  EnvironmentConfiguration,
  MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import {
  DEFAULT_DUST_OPTIONS,
  FluentWalletBuilder,
  MidnightWalletProvider as MidnightWalletProviderClass,
  WalletFactory,
  WalletSaveStateProvider,
  WalletSeeds,
} from '@midnight-ntwrk/testkit-js';
import { createKeystore } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import type { Logger } from 'pino';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { WalletHandler } from './handler.ts';

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
  };
});

vi.mock('@midnight-ntwrk/testkit-js', () => ({
  DEFAULT_DUST_OPTIONS: { additionalFeeOverhead: 1000n },
  DEFAULT_WALLET_STATE_DIRECTORY: './.states',
  FluentWalletBuilder: { forEnvironment: vi.fn() },
  MidnightWalletProvider: { withWallet: vi.fn() },
  WalletFactory: {
    createShieldedWallet: vi.fn(() => ({ tag: 'shielded-fresh' })),
    createUnshieldedWallet: vi.fn(() => ({ tag: 'unshielded' })),
    createDustWallet: vi.fn(() => ({ tag: 'dust' })),
    createWalletFacade: vi.fn(async () => ({ tag: 'wallet-facade' })),
    restoreShieldedWallet: vi.fn(async () => ({ tag: 'shielded-restored' })),
  },
  WalletSaveStateProvider: vi.fn(),
  WalletSeeds: {
    fromMnemonic: vi.fn(() => ({
      shielded: new Uint8Array(32).fill(0x11),
      unshielded: new Uint8Array(32).fill(0x22),
      dust: new Uint8Array(32).fill(0x33),
    })),
    fromMasterSeed: vi.fn(() => ({
      shielded: new Uint8Array(32).fill(0x44),
      unshielded: new Uint8Array(32).fill(0x55),
      dust: new Uint8Array(32).fill(0x66),
    })),
  },
}));

vi.mock('@midnight-ntwrk/wallet-sdk-unshielded-wallet', () => ({
  createKeystore: vi.fn(() => ({ tag: 'keystore' })),
}));

vi.mock('@midnight-ntwrk/ledger-v8', () => ({
  ZswapSecretKeys: { fromSeed: vi.fn(() => ({ tag: 'zswap-keys' })) },
  DustSecretKey: { fromSeed: vi.fn(() => ({ tag: 'dust-key' })) },
}));

interface FakeProvider {
  stop: Mock;
  wallet: { shielded: { tag: string } };
}

function fakeProvider(opts: { failsOnStop?: boolean } = {}): FakeProvider {
  return {
    wallet: { shielded: { tag: 'shielded-on-provider' } },
    stop: vi.fn(
      opts.failsOnStop
        ? async () => {
            throw new Error('boom');
          }
        : async () => undefined,
    ),
  };
}

interface BuilderChain {
  envBuilder: { withDustOptions: Mock; config: unknown };
}

function wireTestkitChain(provider: FakeProvider): BuilderChain {
  const envBuilder = {
    withDustOptions: vi.fn(() => envBuilder),
    config: { tag: 'config' },
  };
  vi.mocked(FluentWalletBuilder.forEnvironment).mockReturnValue(
    envBuilder as unknown as ReturnType<
      typeof FluentWalletBuilder.forEnvironment
    >,
  );
  vi.mocked(MidnightWalletProviderClass.withWallet).mockResolvedValue(
    provider as unknown as MidnightWalletProvider,
  );
  return { envBuilder };
}

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

describe('WalletHandler', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = spyLogger();
    vi.mocked(existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('seed routing', () => {
    it('should route a mnemonic seed through WalletSeeds.fromMnemonic', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(logger, fakeEnv(), {
        kind: 'mnemonic',
        value: 'abandon abandon abandon',
      });
      expect(WalletSeeds.fromMnemonic).toHaveBeenCalledWith(
        'abandon abandon abandon',
      );
      expect(WalletSeeds.fromMasterSeed).not.toHaveBeenCalled();
    });

    it('should route a hex seed through WalletSeeds.fromMasterSeed', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(logger, fakeEnv(), {
        kind: 'hex',
        value: 'aa'.repeat(32),
      });
      expect(WalletSeeds.fromMasterSeed).toHaveBeenCalledWith('aa'.repeat(32));
      expect(WalletSeeds.fromMnemonic).not.toHaveBeenCalled();
    });
  });

  describe('dust overhead', () => {
    it('should override additionalFeeOverhead to a smaller value on non-mainnet networks', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(logger, fakeEnv('preview'), {
        kind: 'hex',
        value: '00',
      });
      // testkit's 5e20 default exceeds a typical preview/preprod wallet's
      // dust balance, breaking fee balance. We tune down to 5e14.
      expect(WalletFactory.createDustWallet).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Uint8Array),
        expect.objectContaining({
          additionalFeeOverhead: 500_000_000_000_000n,
        }),
      );
    });

    it('should keep the testkit default additionalFeeOverhead on mainnet', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(logger, fakeEnv('mainnet'), {
        kind: 'hex',
        value: '00',
      });
      expect(WalletFactory.createDustWallet).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(Uint8Array),
        expect.objectContaining({
          additionalFeeOverhead: DEFAULT_DUST_OPTIONS.additionalFeeOverhead,
        }),
      );
    });
  });

  describe('sync batching', () => {
    it('should default the batchUpdates size to 5000 on the shared config for both sub-wallets', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(logger, fakeEnv('preprod'), {
        kind: 'hex',
        value: '00',
      });
      // The shared config is mutated in place and threaded into every
      // sub-wallet factory, so asserting on the dust + shielded calls proves
      // the OOM workaround (issue #115) covers both. Default SDK batch size
      // is 10, which OOMs replaying preprod's ~1M-event dust stream.
      const withBatch = expect.objectContaining({
        batchUpdates: { size: 5000, timeout: 1, spacing: 4 },
      });
      expect(WalletFactory.createDustWallet).toHaveBeenCalledWith(
        withBatch,
        expect.any(Uint8Array),
        expect.anything(),
      );
      expect(WalletFactory.createShieldedWallet).toHaveBeenCalledWith(
        withBatch,
        expect.any(Uint8Array),
      );
    });

    it('should honour a caller-supplied syncBatchSize override', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv('preprod'),
        { kind: 'hex', value: '00' },
        { syncBatchSize: 1000 },
      );
      // timeout/spacing stay at the validated values; only size changes.
      const withBatch = expect.objectContaining({
        batchUpdates: { size: 1000, timeout: 1, spacing: 4 },
      });
      expect(WalletFactory.createDustWallet).toHaveBeenCalledWith(
        withBatch,
        expect.any(Uint8Array),
        expect.anything(),
      );
      expect(WalletFactory.createShieldedWallet).toHaveBeenCalledWith(
        withBatch,
        expect.any(Uint8Array),
      );
    });
  });

  describe('provider wiring', () => {
    it('should expose the wallet built by MidnightWalletProvider.withWallet via .provider', async () => {
      const provider = fakeProvider();
      wireTestkitChain(provider);
      const handler = await WalletHandler.build(logger, fakeEnv(), {
        kind: 'hex',
        value: '00',
      });
      expect(handler.provider).toBe(provider);
    });

    it('should pass the createWalletFacade output to MidnightWalletProvider.withWallet', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(logger, fakeEnv(), {
        kind: 'hex',
        value: '00',
      });
      // The 3rd positional arg to withWallet is the WalletFacade.
      const args = vi.mocked(MidnightWalletProviderClass.withWallet).mock
        .calls[0];
      expect(args?.[2]).toEqual({ tag: 'wallet-facade' });
    });

    it('should derive the unshielded keystore from the seed bytes and network id', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(logger, fakeEnv('testnet'), {
        kind: 'hex',
        value: '00',
      });
      expect(createKeystore).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        'testnet',
      );
    });
  });

  describe('wallet-state cache', () => {
    it('should build the shielded sub-wallet fresh when no cache file exists', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(logger, fakeEnv(), {
        kind: 'hex',
        value: '00',
      });
      expect(WalletFactory.createShieldedWallet).toHaveBeenCalledTimes(1);
      expect(WalletFactory.restoreShieldedWallet).not.toHaveBeenCalled();
    });

    it('should restore the shielded sub-wallet from cache when the file exists', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(WalletSaveStateProvider).mockImplementation(function (
        this: object,
      ) {
        Object.assign(this, {
          load: vi.fn(async () => 'serialized-state'),
          save: vi.fn(async () => undefined),
        });
      } as unknown as new (
        ...args: unknown[]
      ) => InstanceType<typeof WalletSaveStateProvider>);
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(logger, fakeEnv(), {
        kind: 'hex',
        value: '00',
      });
      expect(WalletFactory.restoreShieldedWallet).toHaveBeenCalledWith(
        expect.anything(),
        'serialized-state',
      );
      expect(WalletFactory.createShieldedWallet).not.toHaveBeenCalled();
    });

    it('should skip the cache entirely when skipWalletCache is true', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: '00' },
        { skipWalletCache: true },
      );
      expect(WalletFactory.restoreShieldedWallet).not.toHaveBeenCalled();
      expect(WalletFactory.createShieldedWallet).toHaveBeenCalledTimes(1);
    });

    it('should fall back to a fresh build when restore throws', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(WalletSaveStateProvider).mockImplementation(function (
        this: object,
      ) {
        Object.assign(this, {
          load: vi.fn(async () => {
            throw new Error('corrupt');
          }),
          save: vi.fn(async () => undefined),
        });
      } as unknown as new (
        ...args: unknown[]
      ) => InstanceType<typeof WalletSaveStateProvider>);
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(logger, fakeEnv(), {
        kind: 'hex',
        value: '00',
      });
      expect(WalletFactory.createShieldedWallet).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'corrupt' }),
        expect.stringContaining('Wallet cache restore failed'),
      );
    });

    it('should swallow save() failures with a warn log on saveCache()', async () => {
      vi.mocked(WalletSaveStateProvider).mockImplementation(function (
        this: object,
      ) {
        Object.assign(this, {
          load: vi.fn(),
          save: vi.fn(async () => {
            throw new Error('disk-full');
          }),
        });
      } as unknown as new (
        ...args: unknown[]
      ) => InstanceType<typeof WalletSaveStateProvider>);
      wireTestkitChain(fakeProvider());
      const handler = await WalletHandler.build(logger, fakeEnv(), {
        kind: 'hex',
        value: '00',
      });
      await expect(handler.saveCache()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'disk-full' }),
        'Wallet sub-wallet cache save failed; continuing',
      );
    });

    it('should save the shielded sub-wallet through WalletSaveStateProvider on saveCache()', async () => {
      const save = vi.fn(async () => undefined);
      vi.mocked(WalletSaveStateProvider).mockImplementation(function (
        this: object,
      ) {
        Object.assign(this, { load: vi.fn(), save });
      } as unknown as new (
        ...args: unknown[]
      ) => InstanceType<typeof WalletSaveStateProvider>);
      const provider = fakeProvider();
      wireTestkitChain(provider);
      const handler = await WalletHandler.build(logger, fakeEnv(), {
        kind: 'hex',
        value: '00',
      });
      await handler.saveCache();
      expect(save).toHaveBeenCalledWith(provider.wallet.shielded);
    });
  });

  describe('seed cache import', () => {
    it('should import a raw-JSON dust source by gzipping into the seed-derived path', async () => {
      const raw = Buffer.from('{"state":"raw-json"}', 'utf8');
      vi.mocked(readFileSync).mockReturnValue(raw);
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv('preview'),
        { kind: 'hex', value: 'aa'.repeat(32) },
        { seedCacheDust: '/path/to/state.json' },
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

    it('should pass a gzipped dust source through unchanged (no double-gzip)', async () => {
      const gzipped = gzipSync(Buffer.from('{"state":"raw-json"}', 'utf8'));
      vi.mocked(readFileSync).mockReturnValue(gzipped);
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv('preview'),
        { kind: 'hex', value: 'aa'.repeat(32) },
        { seedCacheDust: '/path/to/state.gz' },
      );
      const payload = vi.mocked(writeFileSync).mock.calls[0]?.[1];
      expect(payload).toEqual(gzipped);
    });

    it('should ensure the .states/ directory exists before writing', async () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: 'aa'.repeat(32) },
        { seedCacheDust: '/state.json' },
      );
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ recursive: true }),
      );
    });

    it('should throw WalletError when the source file is missing', async () => {
      vi.mocked(readFileSync).mockImplementationOnce(() => {
        throw new Error('ENOENT: no such file');
      });
      wireTestkitChain(fakeProvider());
      await expect(
        WalletHandler.build(
          logger,
          fakeEnv(),
          { kind: 'hex', value: 'aa'.repeat(32) },
          { seedCacheDust: '/missing.json' },
        ),
      ).rejects.toThrow(/--seed-cache-from-dust:.*missing\.json/);
    });

    it('should back up an existing target cache to <target>.bak before overwriting', async () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      vi.mocked(existsSync).mockReturnValue(true);
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: 'aa'.repeat(32) },
        { seedCacheDust: '/state.json' },
      );
      // copyFileSync MUST be called with (target, target.bak) so the
      // previous cache bytes are preserved forever. If this assertion
      // breaks, the safety net we promised the user is gone.
      expect(copyFileSync).toHaveBeenCalledTimes(1);
      const [src, dest] = vi.mocked(copyFileSync).mock.calls[0] ?? [];
      expect(String(src)).toMatch(/-dust\.gz$/);
      expect(String(dest)).toMatch(/-dust\.gz\.bak$/);
      expect(String(dest)).toBe(`${String(src)}.bak`);
      const sawBackupLog = vi
        .mocked(logger.info)
        .mock.calls.some((c) =>
          String(c[0]).includes('previous cache backed up to'),
        );
      expect(sawBackupLog).toBe(true);
    });

    it('should NOT create a .bak when the target cache does not already exist', async () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      vi.mocked(existsSync).mockReturnValue(false);
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: 'aa'.repeat(32) },
        { seedCacheDust: '/state.json' },
      );
      expect(copyFileSync).not.toHaveBeenCalled();
    });

    it('should warn and skip the import when --no-cache is also set', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: 'aa'.repeat(32) },
        { skipWalletCache: true, seedCacheDust: '/state.json' },
      );
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('--seed-cache-from-*'),
      );
    });

    it('should import a shielded source into the matching -shielded.gz path', async () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv('preview'),
        { kind: 'hex', value: 'aa'.repeat(32) },
        { seedCacheShielded: '/state.json' },
      );
      // Final atomic rename lands on `-shielded.gz`; the intermediate
      // tmp write goes to `-shielded.gz.tmp`.
      const renameTo = vi.mocked(renameSync).mock.calls[0]?.[1];
      expect(String(renameTo)).toMatch(/preview-[0-9a-f]{16}-shielded\.gz$/);
    });
  });

  describe('dispose', () => {
    it('should stop the underlying wallet on Symbol.asyncDispose', async () => {
      const provider = fakeProvider();
      wireTestkitChain(provider);
      const handler = await WalletHandler.build(logger, fakeEnv(), {
        kind: 'hex',
        value: '00',
      });
      await handler[Symbol.asyncDispose]();
      expect(provider.stop).toHaveBeenCalledTimes(1);
    });

    it('should swallow stop() failures with a warn log on Symbol.asyncDispose', async () => {
      const provider = fakeProvider({ failsOnStop: true });
      wireTestkitChain(provider);
      const handler = await WalletHandler.build(logger, fakeEnv(), {
        kind: 'hex',
        value: '00',
      });
      await expect(handler[Symbol.asyncDispose]()).resolves.toBeUndefined();
      expect(provider.stop).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'boom' }),
        'Wallet stop failed',
      );
    });
  });
});
