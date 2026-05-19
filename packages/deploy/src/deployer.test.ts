/**
 * Unit tests for the `Deployer` orchestration class.
 *
 * Heavy collaborators (artifact import, proof-server container, wallet
 * build, midnight-js `deployContract`, providers) are replaced via
 * `vi.mock`. The remaining flow — config + signing key + deployments
 * file — runs against real code with a tmpdir fixture. These tests
 * exercise orchestration semantics only (wallet adoption vs build,
 * dispose, dry-run, error wrapping); the end-to-end network path is
 * covered by `tests/integrations/`.
 *
 * Test-only `as unknown as` casts at the mock boundary are intentional:
 * `MidnightWalletProvider` and `WalletHandler` both have private
 * fields and so cannot be produced structurally — duck-typing the
 * small public surface `Deployer` actually touches is the cleanest
 * substitute.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import pino from 'pino';
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
import { DeployTxFailedError } from './errors.ts';
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

const silentLogger = pino({ level: 'silent' });

/**
 * Public surface of `MidnightWalletProvider` that `Deployer` actually
 * calls. Cast to `MidnightWalletProvider` at the boundary where we
 * hand it into the pipeline.
 */
interface FakeProvider {
  getCoinPublicKey: () => string;
  start: Mock;
  stop: Mock;
}

function fakeProvider(coinKey = '0xCOIN'): FakeProvider {
  return {
    getCoinPublicKey: () => coinKey,
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

function asInjected(p: FakeProvider): MidnightWalletProvider {
  return p as unknown as MidnightWalletProvider;
}

interface FakeOwned {
  owned: WalletHandler;
  provider: FakeProvider;
  dispose: Mock;
}

/**
 * Build a `WalletHandler`-shaped fake whose `[Symbol.asyncDispose]`
 * spy mirrors the real class's contract: call `provider.stop()` then
 * record the call. Tests can assert against the dispose spy, the stop
 * spy, or both.
 */
function fakeOwnedWallet(coinKey = '0xCOIN'): FakeOwned {
  const provider = fakeProvider(coinKey);
  const dispose = vi.fn(async () => {
    await provider.stop();
  });
  const owned = {
    provider,
    [Symbol.asyncDispose]: dispose,
  } as unknown as WalletHandler;
  return { owned, provider, dispose };
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

function writeFixture(): Fixture {
  const rootDir = mkdtempSync(join(tmpdir(), 'deployer-test-'));
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

  it('dryRun returns dryRun:true and never submits a tx', async () => {
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

  it('deploy submits the tx and returns the populated success result', async () => {
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

  it('adopts an injected walletProvider without calling WalletHandler.build', async () => {
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

  it('builds + starts a wallet when none is injected', async () => {
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
    expect(built.provider.start).toHaveBeenCalledWith(true);
  });

  it('disposes the owned wallet on asyncDispose but leaves an injected one alone', async () => {
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

  it('wraps midnight-js deploy failures in DeployTxFailedError', async () => {
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
});
