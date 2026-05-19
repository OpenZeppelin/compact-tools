/**
 * Unit tests for the `WalletHandler` class.
 *
 * The whole `testkit-js` builder chain plus `ledger-v8`'s secret-key
 * factories are replaced with `vi.mock` stubs — only the two pieces of
 * business logic that justify this class's existence are exercised:
 *
 *  - **Mnemonic vs hex routing.** `FluentWalletBuilder.withMnemonic`
 *    and `.withSeed(hex)` derive *different* wallets, so picking the
 *    wrong branch silently produces the wrong account.
 *  - **Dust overhead bump.** The `undeployed` dev preset needs
 *    `additionalFeeOverhead = 5e17` or every deploy fails with a
 *    generic `SubmissionError`; every other network keeps the
 *    testkit-js default.
 *
 * The remaining tests cover the disposable contract (provider stop on
 * `[Symbol.asyncDispose]`, warn-log on stop failure).
 */
import type {
  EnvironmentConfiguration,
  MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import {
  DEFAULT_DUST_OPTIONS,
  FluentWalletBuilder,
  MidnightWalletProvider as MidnightWalletProviderClass,
} from '@midnight-ntwrk/testkit-js';
import type { Logger } from 'pino';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { WalletHandler } from './handler.ts';

vi.mock('@midnight-ntwrk/testkit-js', () => ({
  DEFAULT_DUST_OPTIONS: { additionalFeeOverhead: 1000n },
  FluentWalletBuilder: { forEnvironment: vi.fn() },
  MidnightWalletProvider: { withWallet: vi.fn() },
}));

vi.mock('@midnight-ntwrk/ledger-v8', () => ({
  ZswapSecretKeys: { fromSeed: vi.fn(() => ({ tag: 'zswap-keys' })) },
  DustSecretKey: { fromSeed: vi.fn(() => ({ tag: 'dust-key' })) },
}));

interface FakeProvider {
  stop: Mock;
}

function fakeProvider(opts: { failsOnStop?: boolean } = {}): FakeProvider {
  return {
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
  envBuilder: { withDustOptions: Mock };
  dustBuilder: { withMnemonic: Mock; withSeed: Mock };
  seededBuilder: { buildWithoutStarting: Mock };
}

/**
 * Wire up the FluentWalletBuilder + withWallet mock chain so that
 * `WalletHandler.build(...)` produces a handler whose `.provider` is
 * the supplied fake. Returns each link in the chain so tests can
 * assert which method was called.
 */
function wireTestkitChain(provider: FakeProvider): BuilderChain {
  const seededBuilder = {
    buildWithoutStarting: vi.fn(async () => ({
      wallet: { tag: 'wallet-facade' },
      seeds: {
        shielded: new Uint8Array(32),
        dust: new Uint8Array(32),
      },
      keystore: { tag: 'keystore' },
    })),
  };
  const dustBuilder = {
    withMnemonic: vi.fn(() => seededBuilder),
    withSeed: vi.fn(() => seededBuilder),
  };
  const envBuilder = {
    withDustOptions: vi.fn(() => dustBuilder),
  };
  vi.mocked(FluentWalletBuilder.forEnvironment).mockReturnValue(
    envBuilder as unknown as ReturnType<typeof FluentWalletBuilder.forEnvironment>,
  );
  vi.mocked(MidnightWalletProviderClass.withWallet).mockResolvedValue(
    provider as unknown as MidnightWalletProvider,
  );
  return { envBuilder, dustBuilder, seededBuilder };
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
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should route a mnemonic seed through .withMnemonic', async () => {
    const chain = wireTestkitChain(fakeProvider());
    await WalletHandler.build(logger, fakeEnv(), {
      kind: 'mnemonic',
      value: 'abandon abandon abandon',
    });
    expect(chain.dustBuilder.withMnemonic).toHaveBeenCalledWith(
      'abandon abandon abandon',
    );
    expect(chain.dustBuilder.withSeed).not.toHaveBeenCalled();
  });

  it('should route a hex seed through .withSeed', async () => {
    const chain = wireTestkitChain(fakeProvider());
    await WalletHandler.build(logger, fakeEnv(), {
      kind: 'hex',
      value: 'aa'.repeat(32),
    });
    expect(chain.dustBuilder.withSeed).toHaveBeenCalledWith('aa'.repeat(32));
    expect(chain.dustBuilder.withMnemonic).not.toHaveBeenCalled();
  });

  it('should bump additionalFeeOverhead for the undeployed network', async () => {
    const chain = wireTestkitChain(fakeProvider());
    await WalletHandler.build(logger, fakeEnv('undeployed'), {
      kind: 'hex',
      value: '00',
    });
    expect(chain.envBuilder.withDustOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalFeeOverhead: 500_000_000_000_000_000n,
      }),
    );
  });

  it('should keep the testkit default additionalFeeOverhead for other networks', async () => {
    const chain = wireTestkitChain(fakeProvider());
    await WalletHandler.build(logger, fakeEnv('testnet'), {
      kind: 'hex',
      value: '00',
    });
    expect(chain.envBuilder.withDustOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalFeeOverhead: DEFAULT_DUST_OPTIONS.additionalFeeOverhead,
      }),
    );
  });

  it('should expose the wallet built by MidnightWalletProvider.withWallet via .provider', async () => {
    const provider = fakeProvider();
    wireTestkitChain(provider);
    const handler = await WalletHandler.build(logger, fakeEnv(), {
      kind: 'hex',
      value: '00',
    });
    expect(handler.provider).toBe(provider);
  });

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
