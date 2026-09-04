import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  EnvironmentConfiguration,
  MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import {
  FluentWalletBuilder,
  MidnightWalletProvider as MidnightWalletProviderClass,
  WalletFactory,
  WalletSaveStateProvider,
  WalletSeeds,
} from '@midnight-ntwrk/testkit-js';
import {
  createKeystore,
  UnshieldedWallet,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
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
    chmodSync: vi.fn(),
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
  UnshieldedWallet: vi.fn(() => ({
    restore: vi.fn(() => ({ tag: 'unshielded-restored' })),
  })),
}));

vi.mock('@midnight-ntwrk/ledger-v8', () => ({
  ZswapSecretKeys: { fromSeed: vi.fn(() => ({ tag: 'zswap-keys' })) },
  DustSecretKey: { fromSeed: vi.fn(() => ({ tag: 'dust-key' })) },
}));

interface FakeProvider {
  stop: Mock;
  wallet: {
    shielded: { tag: string };
    dust: { tag: string };
    unshielded: { tag: string };
  };
}

function fakeProvider(opts: { failsOnStop?: boolean } = {}): FakeProvider {
  return {
    wallet: {
      shielded: { tag: 'shielded-on-provider' },
      dust: { tag: 'dust-on-provider' },
      unshielded: { tag: 'unshielded-on-provider' },
    },
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

/** Stands in for the directory `compact.toml` was loaded from. */
const ROOT_DIR = '/project/root';

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
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'mnemonic', value: 'abandon abandon abandon' },
        { rootDir: ROOT_DIR },
      );
      expect(WalletSeeds.fromMnemonic).toHaveBeenCalledWith(
        'abandon abandon abandon',
      );
      expect(WalletSeeds.fromMasterSeed).not.toHaveBeenCalled();
    });

    it('should route a hex seed through WalletSeeds.fromMasterSeed', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: 'aa'.repeat(32) },
        { rootDir: ROOT_DIR },
      );
      expect(WalletSeeds.fromMasterSeed).toHaveBeenCalledWith('aa'.repeat(32));
      expect(WalletSeeds.fromMnemonic).not.toHaveBeenCalled();
    });
  });

  describe('dust overhead', () => {
    it('should override additionalFeeOverhead to a smaller value than the testkit default', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv('preview'),
        { kind: 'hex', value: '00' },
        { rootDir: ROOT_DIR },
      );
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
  });

  describe('sync batching', () => {
    it('should default the batchUpdates size to 5000 on the shared config for both sub-wallets', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv('preprod'),
        { kind: 'hex', value: '00' },
        { rootDir: ROOT_DIR },
      );
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
        { rootDir: ROOT_DIR, syncBatchSize: 1000 },
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
      const handler = await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: '00' },
        { rootDir: ROOT_DIR },
      );
      expect(handler.provider).toBe(provider);
    });

    it('should pass the createWalletFacade output to MidnightWalletProvider.withWallet', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: '00' },
        { rootDir: ROOT_DIR },
      );
      // The 3rd positional arg to withWallet is the WalletFacade.
      const args = vi.mocked(MidnightWalletProviderClass.withWallet).mock
        .calls[0];
      expect(args?.[2]).toEqual({ tag: 'wallet-facade' });
    });

    it('should derive the unshielded keystore from the seed bytes and network id', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv('testnet'),
        { kind: 'hex', value: '00' },
        { rootDir: ROOT_DIR },
      );
      expect(createKeystore).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        'testnet',
      );
    });
  });

  describe('wallet-state cache', () => {
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
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: '00' },
        { rootDir: ROOT_DIR },
      );
      expect(WalletFactory.restoreShieldedWallet).toHaveBeenCalledWith(
        expect.anything(),
        'serialized-state',
      );
      expect(WalletFactory.createShieldedWallet).not.toHaveBeenCalled();
    });

    it('should restore the unshielded sub-wallet from cache instead of rebuilding from the keystore', async () => {
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
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: '00' },
        { rootDir: ROOT_DIR },
      );
      expect(UnshieldedWallet).toHaveBeenCalledTimes(1);
      expect(WalletFactory.createUnshieldedWallet).not.toHaveBeenCalled();
    });

    it('should delegate saveCache() to the cache service for all three sub-wallets', async () => {
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
      const handler = await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: '00' },
        { rootDir: ROOT_DIR },
      );
      await handler.saveCache();
      expect(save).toHaveBeenCalledWith(provider.wallet.shielded);
      expect(save).toHaveBeenCalledWith(provider.wallet.dust);
      expect(save).toHaveBeenCalledWith(provider.wallet.unshielded);
      // WalletSaveStateProvider writes at the umask; the snapshot must end
      // up owner-only.
      expect(chmodSync).toHaveBeenCalledWith(expect.any(String), 0o600);
    });
  });

  describe('seed cache import', () => {
    it('should route each --seed-cache-from-* source to its own sub-wallet cache', async () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv('preview'),
        { kind: 'hex', value: 'aa'.repeat(32) },
        {
          rootDir: ROOT_DIR,
          seedCacheShielded: '/shielded.json',
          seedCacheDust: '/dust.json',
          seedCacheUnshielded: '/unshielded.json',
        },
      );
      // Crossed routing would load one sub-wallet's snapshot into
      // another, whose state schema differs.
      const targets = vi.mocked(renameSync).mock.calls.map((c) => String(c[1]));
      expect(targets).toHaveLength(3);
      expect(targets[0]).toMatch(/-shielded\.gz$/);
      expect(targets[1]).toMatch(/-dust\.gz$/);
      expect(targets[2]).toMatch(/-unshielded\.gz$/);
    });

    it.each([
      ['seedCacheShielded'],
      ['seedCacheDust'],
      ['seedCacheUnshielded'],
    ])(
      'should warn and skip the import when --no-cache is set alongside %s',
      async (flag) => {
        wireTestkitChain(fakeProvider());
        await WalletHandler.build(
          logger,
          fakeEnv(),
          { kind: 'hex', value: 'aa'.repeat(32) },
          { rootDir: ROOT_DIR, skipWalletCache: true, [flag]: '/state.json' },
        );
        expect(writeFileSync).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          expect.stringContaining('--seed-cache-from-*'),
        );
      },
    );

    it('should place the wallet-state cache under the rootDir it was given', async () => {
      vi.mocked(readFileSync).mockReturnValue(Buffer.from('{}', 'utf8'));
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv('preprod'),
        { kind: 'hex', value: 'aa'.repeat(32) },
        { rootDir: ROOT_DIR, seedCacheDust: '/dust.json' },
      );
      const target = String(vi.mocked(renameSync).mock.calls[0]?.[1]);
      expect(dirname(target)).toStrictEqual('/project/root/.states');
    });

    it('should not warn when --no-cache is set without any --seed-cache-from-*', async () => {
      wireTestkitChain(fakeProvider());
      await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: 'aa'.repeat(32) },
        { rootDir: ROOT_DIR, skipWalletCache: true },
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('--seed-cache-from-*'),
      );
    });
  });

  describe('dispose', () => {
    it('should stop the underlying wallet on Symbol.asyncDispose', async () => {
      const provider = fakeProvider();
      wireTestkitChain(provider);
      const handler = await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: '00' },
        { rootDir: ROOT_DIR },
      );
      await handler[Symbol.asyncDispose]();
      expect(provider.stop).toHaveBeenCalledTimes(1);
    });

    it('should swallow stop() failures with a warn log on Symbol.asyncDispose', async () => {
      const provider = fakeProvider({ failsOnStop: true });
      wireTestkitChain(provider);
      const handler = await WalletHandler.build(
        logger,
        fakeEnv(),
        { kind: 'hex', value: '00' },
        { rootDir: ROOT_DIR },
      );
      await expect(handler[Symbol.asyncDispose]()).resolves.toBeUndefined();
      expect(provider.stop).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'boom' }),
        'Wallet stop failed',
      );
    });
  });
});
