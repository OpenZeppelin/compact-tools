import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import pino from 'pino';
import * as Rx from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { Deployer } from './deployer.ts';
import { DeployTxFailedError, UnfundedWalletError } from './errors.ts';
import { buildProviders } from './providers/build.ts';
import { WalletHandler } from './wallet/handler.ts';

vi.mock('./loaders/artifact.ts', () => ({
  Artifact: {
    load: vi.fn(async () => ({
      artifactPath: '/fake/artifact',
      zkConfigPath: '/fake/artifact',
      compiledContract: { fake: 'compiled' },
      circuitNames: ['increment'],
    })),
  },
}));

vi.mock('./providers/proof-server.ts', () => ({
  ProofServer: {
    start: vi.fn(async () => ({
      url: 'http://localhost:6300',
      [Symbol.asyncDispose]: async () => {
        // no-op for static-URL stub
      },
    })),
  },
}));

vi.mock('./providers/build.ts', () => ({
  buildProviders: vi.fn(() => ({})),
}));

vi.mock('./wallet/handler.ts', () => ({
  WalletHandler: { build: vi.fn() },
}));

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({
  deployContract: vi.fn(),
}));

// Identity-throttle so `syncAndVerifyFunds`'s progress + checkpoint
// subscriptions fire on the single state emission instead of waiting
// 30 s / 5 min in real wall-clock for the trailing tick.
vi.mock('rxjs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('rxjs')>();
  return {
    ...actual,
    throttleTime:
      () =>
      <T>(src: import('rxjs').Observable<T>): import('rxjs').Observable<T> =>
        src,
  };
});

vi.mock('@midnight-ntwrk/midnight-js-network-id', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@midnight-ntwrk/midnight-js-network-id')
    >();
  return {
    ...actual,
    // logWalletAddresses passes whatever this returns to the codec
    // mock which ignores the arg. Opaque value is fine.
    getNetworkId: vi.fn(() => 0),
  };
});

// Stub the bech32 codec triplet so `logWalletAddresses` reaches its
// happy-path info logs instead of catching at the encode call.
vi.mock('@midnight-ntwrk/wallet-sdk-address-format', () => {
  const codec = {
    encode: vi.fn(() => ({ toString: () => 'addr1stub' })),
  };
  return {
    ShieldedAddress: { codec },
    UnshieldedAddress: { codec },
    DustAddress: { codec },
  };
});

const silentLogger = pino({ level: 'silent' });

interface FakeProvider {
  getCoinPublicKey: () => string;
  start: Mock;
  stop: Mock;
  wallet: {
    state: () => Rx.Observable<unknown>;
    shielded: { tag: string; state?: Rx.Observable<unknown> };
    unshielded?: { state: Rx.Observable<unknown> };
    dust?: { state: Rx.Observable<unknown> };
  };
}

function fakeSubWalletStates() {
  const addr = { address: 'addr-bytes' };
  return {
    shielded: Rx.of(addr),
    unshielded: Rx.of(addr),
    dust: Rx.of(addr),
  };
}

/**
 * Emits one already-synced `FacadeState` with a `Proxy` balance map that
 * returns `1n` for any token key, so `syncAndVerifyFunds` passes through
 * without a real Rx pipeline (we don't mock ledger-v8 in this file).
 */
function fakeProvider(coinKey = '0xCOIN'): FakeProvider {
  const anyKeyHasBalance = new Proxy({} as Record<string, bigint>, {
    get: () => 1n,
  });
  const syncedState = {
    isSynced: true,
    shielded: {
      balances: anyKeyHasBalance,
      state: {
        progress: {
          isStrictlyComplete: () => true,
          isCompleteWithin: () => true,
        },
      },
    },
    unshielded: {
      balances: anyKeyHasBalance,
      progress: {
        isStrictlyComplete: () => true,
        isCompleteWithin: () => true,
      },
    },
    dust: {
      state: {
        progress: {
          isStrictlyComplete: () => true,
          isCompleteWithin: () => true,
        },
      },
      balance: () => 1n,
    },
  };
  const sub = fakeSubWalletStates();
  return {
    getCoinPublicKey: () => coinKey,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    wallet: {
      state: () => Rx.of(syncedState as unknown),
      shielded: { tag: 'shielded', state: sub.shielded },
      unshielded: { state: sub.unshielded },
      dust: { state: sub.dust },
    },
  };
}

function asInjected(p: FakeProvider): MidnightWalletProvider {
  return p as unknown as MidnightWalletProvider;
}

interface FakeOwned {
  owned: WalletHandler;
  provider: FakeProvider;
  dispose: Mock;
  saveCache: Mock;
}

function fakeOwnedWallet(coinKey = '0xCOIN'): FakeOwned {
  return fakeOwnedFromProvider(fakeProvider(coinKey));
}

function fakeOwnedFromProvider(provider: FakeProvider): FakeOwned {
  const dispose = vi.fn(async () => {
    await provider.stop();
  });
  const saveCache = vi.fn(async () => undefined);
  const owned = {
    provider,
    saveCache,
    [Symbol.asyncDispose]: dispose,
  } as unknown as WalletHandler;
  return { owned, provider, dispose, saveCache };
}

/**
 * Provider whose `wallet.state()` is fully caller-controlled. Used to drive
 * timeout / unfunded / mixed-funds branches of `syncAndVerifyFunds`.
 */
function fakeProviderWithState(
  state$: Rx.Observable<unknown>,
  coinKey = '0xCOIN',
): FakeProvider {
  const sub = fakeSubWalletStates();
  return {
    getCoinPublicKey: () => coinKey,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    wallet: {
      state: () => state$,
      shielded: { tag: 'shielded', state: sub.shielded },
      unshielded: { state: sub.unshielded },
      dust: { state: sub.dust },
    },
  };
}

/** Build a single FacadeState with caller-supplied shielded/unshielded balance maps. */
function syncedState(
  shielded: Record<string, bigint>,
  unshielded: Record<string, bigint>,
): unknown {
  return {
    isSynced: true,
    shielded: {
      balances: shielded,
      state: {
        progress: {
          isStrictlyComplete: () => true,
          isCompleteWithin: () => true,
        },
      },
    },
    unshielded: {
      balances: unshielded,
      progress: {
        isStrictlyComplete: () => true,
        isCompleteWithin: () => true,
      },
    },
    dust: {
      state: {
        progress: {
          isStrictlyComplete: () => true,
          isCompleteWithin: () => true,
        },
      },
      balance: () => 0n,
    },
  };
}

type DeployTxResult = Awaited<ReturnType<typeof deployContract>>;
function fakeDeployTxResult(address = '0xCONTRACT'): DeployTxResult {
  return {
    deployTxData: {
      public: {
        contractAddress: address,
        txHash: '0xHASH',
        txId: '0xTX',
        blockHeight: 1234,
      },
    },
  } as unknown as DeployTxResult;
}

interface Fixture {
  rootDir: string;
  configPath: string;
  cleanup: () => void;
}

function writeFixture(
  opts: {
    explorer?: string;
    syncTimeout?: number;
    syncBatchSize?: number;
  } = {},
): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'deployer-test-'));
  const explorerLine = opts.explorer ? `explorer = "${opts.explorer}"\n` : '';
  const syncTimeoutLine =
    opts.syncTimeout !== undefined
      ? `sync_timeout = ${opts.syncTimeout}\n`
      : '';
  const syncBatchLine =
    opts.syncBatchSize !== undefined
      ? `sync_batch_size = ${opts.syncBatchSize}\n`
      : '';
  const toml = `
[profile]
artifacts_dir = "artifacts"
deployments_dir = "deployments"

[networks.local]
network_id = "undeployed"
indexer = "http://localhost:8088/api/v1/graphql"
indexer_ws = "ws://localhost:8088/api/v1/graphql/ws"
node = "http://localhost:9944"
node_ws = "ws://localhost:9944"
proof_server = "http://localhost:6300"
wallet = { source = "local", index = 0 }
${explorerLine}${syncTimeoutLine}${syncBatchLine}
[contracts.Counter]
artifact = "Counter"
signing_key_file = "signing-key.hex"
`;
  writeFileSync(join(rootDir, 'compact.toml'), toml);
  writeFileSync(join(rootDir, 'signing-key.hex'), `${'aa'.repeat(32)}\n`);
  return {
    rootDir,
    configPath: join(rootDir, 'compact.toml'),
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

describe('Deployer', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = writeFixture();
    // Default owned-build returns a fresh fake; tests that need to
    // introspect the built provider override with `mockResolvedValueOnce`.
    vi.mocked(WalletHandler.build).mockImplementation(
      async () => fakeOwnedWallet().owned,
    );
    vi.mocked(deployContract).mockResolvedValue(fakeDeployTxResult());
  });

  afterEach(() => {
    fx.cleanup();
    vi.clearAllMocks();
  });

  it('should return dryRun:true and not submit a tx on dryRun', async () => {
    const injected = fakeProvider('0xINJECTED');
    await using d = await Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: fx.configPath,
      logger: silentLogger,
      walletProvider: asInjected(injected),
    });
    const result = await d.dryRun();

    expect(result.dryRun).toBe(true);
    expect(result.address).toBe('');
    expect(result.txHash).toBe('');
    expect(result.deploymentsFile).toBe('');
    expect(result.contractName).toBe('Counter');
    expect(result.network).toBe('local');
    expect(result.deployer).toBe('0xINJECTED');
    expect(deployContract).not.toHaveBeenCalled();
  });

  it('should submit the tx and return the populated success result on deploy', async () => {
    const injected = fakeProvider('0xDEPLOYER');
    await using d = await Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: fx.configPath,
      logger: silentLogger,
      walletProvider: asInjected(injected),
    });
    const result = await d.deploy();

    expect(deployContract).toHaveBeenCalledTimes(1);
    expect(buildProviders).toHaveBeenCalledTimes(1);
    expect(result.dryRun).toBe(false);
    expect(result.address).toBe('0xCONTRACT');
    expect(result.txHash).toBe('0xHASH');
    expect(result.txId).toBe('0xTX');
    expect(result.blockHeight).toBe(1234);
    expect(result.deployer).toBe('0xDEPLOYER');
    expect(result.deploymentsFile).toContain('deployments');
  });

  it('should adopt an injected walletProvider and not call WalletHandler.build', async () => {
    const injected = fakeProvider();
    await using d = await Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: fx.configPath,
      logger: silentLogger,
      walletProvider: asInjected(injected),
    });
    expect(d.contractName).toBe('Counter');
    expect(WalletHandler.build).not.toHaveBeenCalled();
    expect(injected.start).not.toHaveBeenCalled();
  });

  it('should build and start a wallet when none is injected', async () => {
    const built = fakeOwnedWallet('0xBUILT');
    vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
    await using d = await Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: fx.configPath,
      logger: silentLogger,
    });
    expect(d.deployer).toBe('0xBUILT');
    expect(WalletHandler.build).toHaveBeenCalledTimes(1);
    // Deployer calls start(false) and then runs its own sync gate +
    // saveCache; assert the start arg and that saveCache fired (twice:
    // once via the periodic checkpoint tick, once via the post-sync
    // final snapshot).
    expect(built.provider.start).toHaveBeenCalledWith(false);
    expect(built.saveCache.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('should dispose the owned wallet on asyncDispose but not the injected one', async () => {
    const built = fakeOwnedWallet('0xOWNED');
    const injected = fakeProvider('0xINJ');
    vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
    {
      await using owned = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger: silentLogger,
      });
      expect(owned.deployer).toBe('0xOWNED');
    }
    {
      await using adopted = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger: silentLogger,
        walletProvider: asInjected(injected),
      });
      expect(adopted.deployer).toBe('0xINJ');
    }
    expect(built.dispose).toHaveBeenCalledTimes(1);
    expect(built.provider.stop).toHaveBeenCalledTimes(1);
    expect(injected.stop).not.toHaveBeenCalled();
  });

  it('should wrap midnight-js deploy failures in DeployTxFailedError', async () => {
    vi.mocked(deployContract).mockRejectedValueOnce(
      new Error('chain rejected'),
    );
    const injected = fakeProvider();
    await using d = await Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: fx.configPath,
      logger: silentLogger,
      walletProvider: asInjected(injected),
    });
    await expect(d.deploy()).rejects.toBeInstanceOf(DeployTxFailedError);
  });

  describe('syncAndVerifyFunds (owned-wallet branch)', () => {
    it('should reject with a timeout error when the wallet never reaches chain tip', async () => {
      const built = fakeOwnedFromProvider(
        fakeProviderWithState(Rx.NEVER, '0xSTUCK'),
      );
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
      await expect(
        Deployer.prepare({
          contract: 'Counter',
          network: 'local',
          configPath: fx.configPath,
          logger: silentLogger,
          syncTimeoutMs: 50,
        }),
      ).rejects.toThrow(/Wallet sync timeout after 50ms/);
    });

    it('should complete sync when sub-wallets are within the gap but not strictly complete', async () => {
      // Live-chain shape (issue #115): the global dust stream keeps
      // advancing, so dust is never strictly complete (gap 0) but settles
      // within the tolerated gap. The old strict `isSynced` gate would hang
      // here forever; the tolerant `isCompleteWithin` gate must proceed.
      const anyBal = new Proxy({} as Record<string, bigint>, {
        get: () => 1n,
      });
      const liveTipState = {
        isSynced: false,
        shielded: {
          balances: anyBal,
          state: {
            progress: {
              isStrictlyComplete: () => true,
              isCompleteWithin: () => true,
            },
          },
        },
        unshielded: {
          balances: anyBal,
          progress: {
            isStrictlyComplete: () => true,
            isCompleteWithin: () => true,
          },
        },
        dust: {
          state: {
            progress: {
              isStrictlyComplete: () => false,
              isCompleteWithin: () => true,
            },
          },
          balance: () => 1n,
        },
      };
      const built = fakeOwnedFromProvider(
        fakeProviderWithState(Rx.of(liveTipState as unknown), '0xLIVE-TIP'),
      );
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
      await using d = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger: silentLogger,
        syncTimeoutMs: 1000,
      });
      expect(d.deployer).toBe('0xLIVE-TIP');
    });

    it('should NOT complete sync while any sub-wallet is outside the gap', async () => {
      // Dust still outside the tolerated gap: the gate must keep waiting and
      // ultimately time out rather than deploy against a half-synced wallet.
      const anyBal = new Proxy({} as Record<string, bigint>, {
        get: () => 1n,
      });
      const laggingState = {
        isSynced: false,
        shielded: {
          balances: anyBal,
          state: {
            progress: {
              isStrictlyComplete: () => true,
              isCompleteWithin: () => true,
            },
          },
        },
        unshielded: {
          balances: anyBal,
          progress: {
            isStrictlyComplete: () => true,
            isCompleteWithin: () => true,
          },
        },
        dust: {
          state: {
            progress: {
              isStrictlyComplete: () => false,
              isCompleteWithin: () => false,
            },
          },
          balance: () => 1n,
        },
      };
      // Emit the lagging state, then hang: the gate filters it out and must
      // keep waiting (not complete the sequence) so the timeout can fire.
      const built = fakeOwnedFromProvider(
        fakeProviderWithState(
          Rx.concat(Rx.of(laggingState as unknown), Rx.NEVER),
          '0xLAGGING',
        ),
      );
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
      await expect(
        Deployer.prepare({
          contract: 'Counter',
          network: 'local',
          configPath: fx.configPath,
          logger: silentLogger,
          syncTimeoutMs: 50,
        }),
      ).rejects.toThrow(/Wallet sync timeout after 50ms/);
    });

    it('should throw UnfundedWalletError when shielded and unshielded balances are both empty', async () => {
      const built = fakeOwnedFromProvider(
        fakeProviderWithState(Rx.of(syncedState({}, {})), '0xEMPTY'),
      );
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
      await expect(
        Deployer.prepare({
          contract: 'Counter',
          network: 'local',
          configPath: fx.configPath,
          logger: silentLogger,
          syncTimeoutMs: 1000,
        }),
      ).rejects.toBeInstanceOf(UnfundedWalletError);
    });

    it('should NOT throw when only the unshielded side has a positive balance', async () => {
      // Use a Proxy so any token key returns the expected balance. The
      // ledger token raw key is opaque from this file.
      const unshieldedAny = new Proxy({} as Record<string, bigint>, {
        get: () => 5n,
      });
      const built = fakeOwnedFromProvider(
        fakeProviderWithState(
          Rx.of(syncedState({}, unshieldedAny)),
          '0xUNSHIELDED-ONLY',
        ),
      );
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
      await using d = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger: silentLogger,
        syncTimeoutMs: 1000,
      });
      expect(d.deployer).toBe('0xUNSHIELDED-ONLY');
      expect(built.saveCache.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('should NOT throw when only the shielded side has a positive balance', async () => {
      const shieldedAny = new Proxy({} as Record<string, bigint>, {
        get: () => 3n,
      });
      const built = fakeOwnedFromProvider(
        fakeProviderWithState(
          Rx.of(syncedState(shieldedAny, {})),
          '0xSHIELDED-ONLY',
        ),
      );
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
      await using d = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger: silentLogger,
        syncTimeoutMs: 1000,
      });
      expect(d.deployer).toBe('0xSHIELDED-ONLY');
    });
  });

  describe('wallet build options', () => {
    it('should forward syncBatchSize to WalletHandler.build', async () => {
      const built = fakeOwnedWallet('0xBATCH');
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
      await using d = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger: silentLogger,
        syncTimeoutMs: 1000,
        syncBatchSize: 2500,
      });
      expect(d.deployer).toBe('0xBATCH');
      expect(WalletHandler.build).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ syncBatchSize: 2500 }),
      );
    });

    it('should use the TOML [networks.X].sync_batch_size when no option is passed', async () => {
      const customFx = writeFixture({ syncBatchSize: 1234 });
      try {
        const built = fakeOwnedWallet('0xTOML-BATCH');
        vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
        await using d = await Deployer.prepare({
          contract: 'Counter',
          network: 'local',
          configPath: customFx.configPath,
          logger: silentLogger,
          syncTimeoutMs: 1000,
        });
        expect(d.deployer).toBe('0xTOML-BATCH');
        expect(WalletHandler.build).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ syncBatchSize: 1234 }),
        );
      } finally {
        customFx.cleanup();
      }
    });

    it('should let the syncBatchSize option override the TOML value', async () => {
      const customFx = writeFixture({ syncBatchSize: 1234 });
      try {
        const built = fakeOwnedWallet('0xOVERRIDE');
        vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
        await using d = await Deployer.prepare({
          contract: 'Counter',
          network: 'local',
          configPath: customFx.configPath,
          logger: silentLogger,
          syncTimeoutMs: 1000,
          syncBatchSize: 9999,
        });
        expect(d.deployer).toBe('0xOVERRIDE');
        expect(WalletHandler.build).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ syncBatchSize: 9999 }),
        );
      } finally {
        customFx.cleanup();
      }
    });

    it('should apply the TOML [networks.X].sync_timeout (seconds) as the sync ceiling', async () => {
      // 1s TOML timeout against a never-syncing wallet must trip at 1000ms.
      const customFx = writeFixture({ syncTimeout: 1 });
      try {
        const built = fakeOwnedFromProvider(
          fakeProviderWithState(Rx.NEVER, '0xTOML-TIMEOUT'),
        );
        vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
        await expect(
          Deployer.prepare({
            contract: 'Counter',
            network: 'local',
            configPath: customFx.configPath,
            logger: silentLogger,
          }),
        ).rejects.toThrow(/Wallet sync timeout after 1000ms/);
      } finally {
        customFx.cleanup();
      }
    });
  });

  describe('explorer URL', () => {
    it('should return an empty explorerUrl when no explorer is configured', async () => {
      const injected = fakeProvider('0xDEP');
      await using d = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger: silentLogger,
        walletProvider: asInjected(injected),
      });
      const result = await d.deploy();
      expect(result.explorerUrl).toBe('');
    });

    it('should return an empty explorerUrl when the address is empty', async () => {
      const customFx = writeFixture({ explorer: 'https://explorer.example' });
      try {
        vi.mocked(deployContract).mockResolvedValueOnce({
          deployTxData: {
            public: {
              contractAddress: '',
              txHash: '0xH',
              txId: '0xT',
              blockHeight: 1,
            },
          },
        } as unknown as DeployTxResult);
        const injected = fakeProvider('0xDEP');
        await using d = await Deployer.prepare({
          contract: 'Counter',
          network: 'local',
          configPath: customFx.configPath,
          logger: silentLogger,
          walletProvider: asInjected(injected),
        });
        const result = await d.deploy();
        expect(result.explorerUrl).toBe('');
      } finally {
        customFx.cleanup();
      }
    });

    it('should NOT double-prefix when the address already starts with 0x', async () => {
      const customFx = writeFixture({ explorer: 'https://explorer.example' });
      try {
        // fakeDeployTxResult default address already includes the 0x prefix.
        const injected = fakeProvider('0xDEP');
        await using d = await Deployer.prepare({
          contract: 'Counter',
          network: 'local',
          configPath: customFx.configPath,
          logger: silentLogger,
          walletProvider: asInjected(injected),
        });
        const result = await d.deploy();
        expect(result.explorerUrl).toBe(
          'https://explorer.example/contracts/0xCONTRACT',
        );
      } finally {
        customFx.cleanup();
      }
    });

    it('should add the 0x prefix when the address lacks one', async () => {
      const customFx = writeFixture({ explorer: 'https://explorer.example' });
      try {
        vi.mocked(deployContract).mockResolvedValueOnce(
          fakeDeployTxResult('BARE'),
        );
        const injected = fakeProvider('0xDEP');
        await using d = await Deployer.prepare({
          contract: 'Counter',
          network: 'local',
          configPath: customFx.configPath,
          logger: silentLogger,
          walletProvider: asInjected(injected),
        });
        const result = await d.deploy();
        expect(result.explorerUrl).toBe(
          'https://explorer.example/contracts/0xBARE',
        );
      } finally {
        customFx.cleanup();
      }
    });

    it('should strip a trailing slash from the explorer base', async () => {
      const customFx = writeFixture({ explorer: 'https://explorer.example/' });
      try {
        const injected = fakeProvider('0xDEP');
        await using d = await Deployer.prepare({
          contract: 'Counter',
          network: 'local',
          configPath: customFx.configPath,
          logger: silentLogger,
          walletProvider: asInjected(injected),
        });
        const result = await d.deploy();
        expect(result.explorerUrl).toBe(
          'https://explorer.example/contracts/0xCONTRACT',
        );
      } finally {
        customFx.cleanup();
      }
    });
  });

  describe('resolveTargets', () => {
    it('should throw ConfigError when no --network is passed and no [profile].default_network is set', async () => {
      // fixture has no default_network, so omitting `network` triggers the throw
      await expect(
        Deployer.prepare({
          contract: 'Counter',
          configPath: fx.configPath,
          logger: silentLogger,
          walletProvider: asInjected(fakeProvider()),
        }),
      ).rejects.toThrow(/No network selected/);
    });
  });

  describe('owned-wallet saveCache failure', () => {
    it('should warn-log and continue when the post-sync saveCache throws', async () => {
      const provider = fakeProvider('0xWARN');
      const dispose = vi.fn(async () => {
        await provider.stop();
      });
      // First call comes from the checkpoint sub (best-effort, never
      // awaited by the source) and we let it succeed to avoid leaking
      // an unhandled rejection from the `onCheckpoint().finally(...)`
      // in the source. The second call is the awaited post-sync save
      // whose failure we DO want to assert is warn-logged.
      let calls = 0;
      const saveCache = vi.fn(async () => {
        calls += 1;
        if (calls === 1) return;
        throw new Error('disk full');
      });
      const owned = {
        provider,
        saveCache,
        [Symbol.asyncDispose]: dispose,
      } as unknown as WalletHandler;
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(owned);

      const warn = vi.fn();
      const loggerWithWarn = pino({ level: 'silent' });
      (loggerWithWarn as any).warn = warn;

      await using d = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger: loggerWithWarn,
        syncTimeoutMs: 1000,
      });
      expect(d.deployer).toBe('0xWARN');
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'disk full' }),
        expect.stringContaining('Wallet cache save failed'),
      );
    });
  });

  describe('logWalletAddresses', () => {
    it('should log the three bech32 addresses on the owned-wallet happy path', async () => {
      const built = fakeOwnedWallet('0xADDR');
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);

      const info = vi.fn();
      const logger = pino({ level: 'silent' });
      (logger as any).info = info;

      await using d = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger,
        syncTimeoutMs: 1000,
      });
      expect(d.deployer).toBe('0xADDR');
      expect(info).toHaveBeenCalledWith(
        'Wallet addresses (verify these match your seed):',
      );
      expect(info).toHaveBeenCalledWith(
        expect.stringMatching(/shielded:.*addr1stub/),
      );
    });
  });

  describe('describeProgress branches', () => {
    it('should render the progress percentage when highest > 0', async () => {
      // Mid-sync state (still short of the tip) that drives the progress
      // subscription's "else" branch (highest > 0). Then a follow-up
      // tip-reached state lets the `isCompleteWithin` gate resolve so the
      // prepare call terminates.
      const midState = {
        isSynced: false,
        shielded: {
          balances: {} as Record<string, bigint>,
          state: {
            progress: {
              isStrictlyComplete: () => false,
              isCompleteWithin: () => false,
              appliedIndex: 10n,
              highestIndex: 100n,
              isConnected: true,
            },
          },
        },
        unshielded: {
          balances: {} as Record<string, bigint>,
          progress: {
            isStrictlyComplete: () => false,
            isCompleteWithin: () => false,
            appliedId: 5n,
            highestTransactionId: 50n,
            isConnected: true,
          },
        },
        dust: {
          state: {
            progress: {
              isStrictlyComplete: () => false,
              isCompleteWithin: () => false,
              appliedIndex: 1n,
              highestIndex: 10n,
              isConnected: true,
            },
          },
          balance: () => 0n,
        },
      };
      const anyKeyHasBalance = new Proxy({} as Record<string, bigint>, {
        get: () => 1n,
      });
      const syncedState = {
        isSynced: true,
        shielded: {
          balances: anyKeyHasBalance,
          state: {
            progress: {
              isStrictlyComplete: () => true,
              isCompleteWithin: () => true,
            },
          },
        },
        unshielded: {
          balances: anyKeyHasBalance,
          progress: {
            isStrictlyComplete: () => true,
            isCompleteWithin: () => true,
          },
        },
        dust: {
          state: {
            progress: {
              isStrictlyComplete: () => true,
              isCompleteWithin: () => true,
            },
          },
          balance: () => 1n,
        },
      };
      const built = fakeOwnedFromProvider(
        fakeProviderWithState(
          Rx.of(midState as unknown, syncedState as unknown),
          '0xPROGRESS',
        ),
      );
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
      await using d = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger: silentLogger,
        syncTimeoutMs: 1000,
      });
      expect(d.deployer).toBe('0xPROGRESS');
    });
  });
});
