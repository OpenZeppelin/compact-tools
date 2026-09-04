import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createUnprovenDeployTx,
  submitTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import pino, { type Logger } from 'pino';
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
import {
  DeploymentsFileError,
  DeployTxFailedError,
  PendingDeployExistsError,
} from './errors.ts';
import { buildProviders } from './providers/build.ts';
import { WalletHandler } from './wallet/handler.ts';

/** Lets one test make the deployments lock unobtainable. */
const lock = vi.hoisted(() => ({ failure: undefined as Error | undefined }));

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
  buildProviders: vi.fn(),
}));

vi.mock('./wallet/handler.ts', () => ({
  WalletHandler: { build: vi.fn() },
}));

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({
  createUnprovenDeployTx: vi.fn(),
  submitTxAsync: vi.fn(),
}));

// Real lock everywhere except the one test that needs a timeout: the wait is
// 10 s in production, too long to spend proving that deploy() reports it.
vi.mock('./services/file-lock.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./services/file-lock.ts')>();
  return {
    ...actual,
    acquireLock: async (lockPath: string) => {
      if (lock.failure) throw lock.failure;
      await actual.acquireLock(lockPath);
    },
  };
});

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
          appliedIndex: 0n,
          highestIndex: 0n,
          isConnected: true,
        },
      },
    },
    unshielded: {
      balances: anyKeyHasBalance,
      // Id-shaped, unlike the index-shaped shielded and dust progress.
      progress: {
        isStrictlyComplete: () => true,
        isCompleteWithin: () => true,
        appliedId: 0n,
        highestTransactionId: 0n,
        isConnected: true,
      },
    },
    dust: {
      state: {
        progress: {
          isStrictlyComplete: () => true,
          isCompleteWithin: () => true,
          appliedIndex: 0n,
          highestIndex: 0n,
          isConnected: true,
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

function fakeUnsubmittedDeploy(address = '0xCONTRACT') {
  return {
    public: { contractAddress: address },
    private: {
      unprovenTx: { tag: 'unproven' },
      signingKey: 'contract-maintenance-key',
      initialPrivateState: { seeded: true },
    },
  };
}

function fakeFinalized(overrides: Record<string, unknown> = {}) {
  return {
    status: 'SucceedEntirely',
    txId: '0xTX',
    txHash: '0xHASH',
    blockHeight: 1234,
    ...overrides,
  };
}

interface FakeProviders {
  publicDataProvider: { watchForTxData: Mock };
  privateStateProvider: {
    setContractAddress: Mock;
    set: Mock;
    setSigningKey: Mock;
  };
}

function fakeProviders(): FakeProviders {
  return {
    publicDataProvider: {
      watchForTxData: vi.fn(async () => fakeFinalized()),
    },
    privateStateProvider: {
      setContractAddress: vi.fn(),
      set: vi.fn(async () => undefined),
      setSigningKey: vi.fn(async () => undefined),
    },
  };
}

/** Pino stubbed down to the four levels the deploy path uses. */
function recordingLogger(): { logger: Logger; info: Mock } {
  const info = vi.fn();
  return {
    logger: {
      info,
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger,
    info,
  };
}

/** The head ledger file for the fixture's only network. */
function headPath(rootDir: string): string {
  return join(rootDir, 'deployments', 'local.json');
}

function readHead(rootDir: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(headPath(rootDir), 'utf8'));
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
    initPrivateState?: string;
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
  const initStateLine =
    opts.initPrivateState !== undefined
      ? `init_private_state = { file = "${opts.initPrivateState}" }\n`
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
${initStateLine}`;
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
  let providers: FakeProviders;

  beforeEach(() => {
    fx = writeFixture();
    // Default owned-build returns a fresh fake; tests that need to
    // introspect the built provider override with `mockResolvedValueOnce`.
    vi.mocked(WalletHandler.build).mockImplementation(
      async () => fakeOwnedWallet().owned,
    );
    providers = fakeProviders();
    vi.mocked(buildProviders).mockImplementation(() => providers as never);
    vi.mocked(createUnprovenDeployTx).mockResolvedValue(
      fakeUnsubmittedDeploy() as never,
    );
    vi.mocked(submitTxAsync).mockResolvedValue('0xTX');
  });

  afterEach(() => {
    fx.cleanup();
    lock.failure = undefined;
    vi.clearAllMocks();
  });

  /** Prepared deployer over the fixture config with an injected wallet. */
  function prepared(
    opts: { logger?: Logger; force?: boolean; txTimeoutMs?: number } = {},
    coinKey = '0xDEPLOYER',
  ): Promise<Deployer> {
    return Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: fx.configPath,
      logger: opts.logger ?? silentLogger,
      walletProvider: asInjected(fakeProvider(coinKey)),
      force: opts.force,
      txTimeoutMs: opts.txTimeoutMs,
    });
  }

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
    expect(submitTxAsync).not.toHaveBeenCalled();
  });

  it('should submit the tx and return the populated success result on deploy', async () => {
    await using d = await prepared();
    const result = await d.deploy();

    expect(submitTxAsync).toHaveBeenCalledTimes(1);
    expect(buildProviders).toHaveBeenCalledTimes(1);
    expect(result.dryRun).toBe(false);
    expect(result.address).toBe('0xCONTRACT');
    expect(result.txHash).toBe('0xHASH');
    expect(result.txId).toBe('0xTX');
    expect(result.blockHeight).toBe(1234);
    expect(result.deployer).toBe('0xDEPLOYER');
    expect(result.deploymentsFile).toContain('deployments');
  });

  it('should build the providers with the compact.toml directory as rootDir', async () => {
    // Anchors the LevelDB private-state directory to the project rather
    // than to wherever the deploy was launched from.
    const injected = fakeProvider('0xDEPLOYER');
    await using d = await Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: fx.configPath,
      logger: silentLogger,
      walletProvider: asInjected(injected),
    });
    await d.deploy();

    expect(buildProviders).toHaveBeenCalledWith(
      expect.objectContaining({ rootDir: fx.rootDir }),
    );
  });

  it('should keep the signing key out of the result and the written ledger', async () => {
    const injected = fakeProvider('0xDEPLOYER');
    await using d = await Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: fx.configPath,
      logger: silentLogger,
      walletProvider: asInjected(injected),
    });
    const result = await d.deploy();

    // The fixture's signing-key.hex; midnight-js persists it via
    // privateStateProvider.setSigningKey, so nothing here should carry it.
    const signingKeyHex = 'aa'.repeat(32);
    expect(Object.keys(result)).not.toContain('signingKey');
    expect(JSON.stringify(result)).not.toContain(signingKeyHex);

    const ledger = readFileSync(result.deploymentsFile, 'utf8');
    expect(ledger).not.toContain('signingKey');
    expect(ledger).not.toContain(signingKeyHex);
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
    vi.mocked(submitTxAsync).mockRejectedValueOnce(new Error('chain rejected'));
    await using d = await prepared();
    await expect(d.deploy()).rejects.toBeInstanceOf(DeployTxFailedError);
  });

  describe('pending-then-confirmed ledger', () => {
    it('should log the address and txId before the wait for finalization', async () => {
      const { logger, info } = recordingLogger();
      let loggedBeforeWatch: unknown[] = [];
      providers.publicDataProvider.watchForTxData.mockImplementation(
        async () => {
          loggedBeforeWatch = info.mock.calls.flat();
          return fakeFinalized();
        },
      );

      await using d = await prepared({ logger });
      await d.deploy();

      expect(loggedBeforeWatch).toContainEqual(
        expect.objectContaining({ address: '0xCONTRACT', txId: '0xTX' }),
      );
    });

    it('should have the pending record on disk before the wait for finalization', async () => {
      let headDuringWatch: Record<string, unknown> = {};
      providers.publicDataProvider.watchForTxData.mockImplementation(
        async () => {
          headDuringWatch = readHead(fx.rootDir).Counter ?? {};
          return fakeFinalized();
        },
      );

      await using d = await prepared();
      await d.deploy();

      expect(headDuringWatch).toMatchObject({
        status: 'pending',
        address: '0xCONTRACT',
        txId: '0xTX',
        deployer: '0xDEPLOYER',
      });
    });

    it('should promote the record to confirmed once the tx succeeds', async () => {
      await using d = await prepared();
      const result = await d.deploy();

      expect(readHead(fx.rootDir).Counter).toMatchObject({
        status: 'confirmed',
        address: '0xCONTRACT',
        txId: '0xTX',
        txHash: '0xHASH',
        blockHeight: 1234,
      });
      // Promotion replaces the pending half of the same deploy in place.
      expect(result.deploymentsFile).toBe(headPath(fx.rootDir));
    });

    it('should leave the record pending and name the txId when the watch rejects', async () => {
      providers.publicDataProvider.watchForTxData.mockRejectedValue(
        new Error('socket closed'),
      );

      await using d = await prepared();
      const thrown = await d.deploy().catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(DeployTxFailedError);
      expect((thrown as Error).message).toContain('0xTX');
      expect((thrown as Error).message).toContain('0xCONTRACT');
      expect(readHead(fx.rootDir).Counter).toMatchObject({
        status: 'pending',
      });
    });

    it('should leave the record pending and name the txId when the watch times out', async () => {
      providers.publicDataProvider.watchForTxData.mockImplementation(
        () => new Promise(() => {}),
      );

      await using d = await prepared({ txTimeoutMs: 5 });
      const thrown = await d.deploy().catch((e: unknown) => e);

      expect((thrown as Error).message).toContain(
        'no finalization within 5 ms',
      );
      expect((thrown as Error).message).toContain('0xTX');
      expect(readHead(fx.rootDir).Counter).toMatchObject({
        status: 'pending',
      });
    });

    it('should refuse to deploy over a pending record without submitting a tx', async () => {
      providers.publicDataProvider.watchForTxData.mockRejectedValue(
        new Error('socket closed'),
      );
      {
        await using first = await prepared();
        await first.deploy().catch(() => undefined);
      }
      vi.mocked(submitTxAsync).mockClear();

      await using second = await prepared();
      const thrown = await second.deploy().catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(PendingDeployExistsError);
      expect((thrown as Error).message).toContain('0xTX');
      expect(submitTxAsync).not.toHaveBeenCalled();
    });

    it('should replace a pending record under force', async () => {
      providers.publicDataProvider.watchForTxData.mockRejectedValueOnce(
        new Error('socket closed'),
      );
      {
        await using first = await prepared();
        await first.deploy().catch(() => undefined);
      }

      await using second = await prepared({ force: true });
      const result = await second.deploy();

      expect(result.address).toBe('0xCONTRACT');
      expect(readHead(fx.rootDir).Counter).toMatchObject({
        status: 'confirmed',
      });
    });

    it('should store the private state and signing key only after a success status', async () => {
      providers.publicDataProvider.watchForTxData.mockResolvedValue(
        fakeFinalized({ status: 'FailEntirely' }),
      );

      await using d = await prepared();
      await expect(d.deploy()).rejects.toThrow(/FailEntirely/);

      expect(
        providers.privateStateProvider.setContractAddress,
      ).not.toHaveBeenCalled();
      expect(
        providers.privateStateProvider.setSigningKey,
      ).not.toHaveBeenCalled();
    });

    it('should store the address and the signing key once the tx succeeds', async () => {
      await using d = await prepared();
      await d.deploy();

      expect(
        providers.privateStateProvider.setContractAddress,
      ).toHaveBeenCalledWith('0xCONTRACT');
      expect(providers.privateStateProvider.setSigningKey).toHaveBeenCalledWith(
        '0xCONTRACT',
        'contract-maintenance-key',
      );
      // No [contracts.Counter].private_state_id in the fixture.
      expect(providers.privateStateProvider.set).not.toHaveBeenCalled();
    });

    it('should surface the refusal when another process claims the contract mid-deploy', async () => {
      // The precheck passed against an empty ledger; a second deploy wrote its
      // pending record before ours reached the lock.
      vi.mocked(submitTxAsync).mockImplementation(async () => {
        mkdirSync(join(fx.rootDir, 'deployments'), { recursive: true });
        writeFileSync(
          headPath(fx.rootDir),
          JSON.stringify({
            Counter: {
              status: 'pending',
              address: '0xOTHER',
              txId: '0xOTHERTX',
              deployer: '0xDEPLOYER',
              artifact: 'Counter',
              submittedAt: new Date().toISOString(),
            },
          }),
        );
        return '0xTX';
      });

      await using d = await prepared();
      const thrown = await d.deploy().catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(PendingDeployExistsError);
      expect((thrown as Error).message).toContain('0xOTHERTX');
    });
  });

  describe('ledger write failures', () => {
    it('should name the address in the error when the deployments lock times out', async () => {
      lock.failure = new Error(
        'Timed out waiting for the deployments lock at /tmp/local.json.lock',
      );

      await using d = await prepared();
      const thrown = await d.deploy().catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(DeploymentsFileError);
      expect((thrown as Error).message).toContain('0xCONTRACT');
      expect((thrown as Error).message).toContain('0xTX');
      expect((thrown as Error).message).toContain('Timed out waiting');
    });

    it('should name the file and submit nothing when <network>.json is already corrupt', async () => {
      mkdirSync(join(fx.rootDir, 'deployments'), { recursive: true });
      writeFileSync(headPath(fx.rootDir), '{"Counter": {');

      await using d = await prepared();
      const thrown = await d.deploy().catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(DeploymentsFileError);
      expect((thrown as Error).message).toContain('is not valid JSON');
      expect((thrown as Error).message).toContain(headPath(fx.rootDir));
      expect(submitTxAsync).not.toHaveBeenCalled();
    });

    it('should carry the txHash when the confirmed write is the one that fails', async () => {
      // Corrupt the ledger between the pending write and the promotion, so the
      // failure lands on the write that has an on-chain txHash to report.
      providers.publicDataProvider.watchForTxData.mockImplementation(
        async () => {
          writeFileSync(headPath(fx.rootDir), '{"Counter": {');
          return fakeFinalized();
        },
      );

      await using d = await prepared();
      const thrown = await d.deploy().catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(DeploymentsFileError);
      expect((thrown as Error).message).toContain('txHash 0xHASH');
      expect((thrown as Error).message).toContain('0xTX');
    });
  });

  describe('wallet build options', () => {
    it('should forward the compact.toml directory as the wallet-cache rootDir', async () => {
      // Not process.cwd(): the wallet cache and the private-state DB
      // belong to the project the config was loaded from.
      const built = fakeOwnedWallet('0xROOT');
      vi.mocked(WalletHandler.build).mockResolvedValueOnce(built.owned);
      await using d = await Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: fx.configPath,
        logger: silentLogger,
        syncTimeoutMs: 1000,
      });
      expect(d.deployer).toBe('0xROOT');
      expect(WalletHandler.build).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ rootDir: fx.rootDir }),
      );
    });

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

  describe('load order', () => {
    it('should reject a bad args source before the wallet is built', async () => {
      // A typo in --args must not cost a 30-60 min first sync.
      await expect(
        Deployer.prepare({
          contract: 'Counter',
          network: 'local',
          configPath: fx.configPath,
          logger: silentLogger,
          argsOverride: '[1, 2',
        }),
      ).rejects.toThrow(/args: invalid JSON at --args/);
      expect(WalletHandler.build).not.toHaveBeenCalled();
    });

    it('should reject a missing init-state file before the wallet is built', async () => {
      const customFx = writeFixture({
        initPrivateState: '/missing/state.json',
      });
      try {
        await expect(
          Deployer.prepare({
            contract: 'Counter',
            network: 'local',
            configPath: customFx.configPath,
            logger: silentLogger,
          }),
        ).rejects.toThrow();
        expect(WalletHandler.build).not.toHaveBeenCalled();
      } finally {
        customFx.cleanup();
      }
    });
  });

  describe('explorer URL', () => {
    it('should surface the explorer URL built from the deployed address', async () => {
      const customFx = writeFixture({ explorer: 'https://explorer.example' });
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
});
