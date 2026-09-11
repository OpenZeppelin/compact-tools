import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type MaintenanceUpdate,
  signatureVerifyingKey,
  type VerifierKeyInsert,
  verifySignature,
} from '@midnight-ntwrk/ledger-v8';
import {
  createUnprovenDeployTx,
  submitTxAsync,
} from '@midnight-ntwrk/midnight-js-contracts';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import type { Logger } from 'pino';
import * as Rx from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeProviders,
  type Fixture,
  fakeProviders,
  fakeUnsubmittedDeploy,
  fakeVerifierKeys,
  headPath,
  readHead,
  recordingLogger,
  silentLogger,
  writeFixture,
} from './deployer.testkit.ts';
import { Deployer } from './deployer.ts';
import {
  BlockLimitError,
  ConfigError,
  DeploymentsFileError,
  DeployTxFailedError,
  FragmentDeployError,
} from './errors.ts';
import { Artifact } from './loaders/artifact.ts';
import { buildProviders } from './providers/build.ts';
import { ProofServer } from './providers/proof-server.ts';
import { submitDeploy } from './services/deploy-tx.ts';
import { buildInsertUpdate } from './services/maintenance-tx.ts';

vi.mock('./loaders/artifact.ts', () => ({
  Artifact: { load: vi.fn() },
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

vi.mock('./providers/build.ts', () => ({ buildProviders: vi.fn() }));

vi.mock('@midnight-ntwrk/midnight-js-contracts', () => ({
  createUnprovenDeployTx: vi.fn(),
  submitTxAsync: vi.fn(),
  verifierKeysEqual: (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]),
}));

// Real implementations throughout; the spy is only so a test can read the
// signed `MaintenanceUpdate` the loop built.
vi.mock('./services/maintenance-tx.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./services/maintenance-tx.ts')>();
  return { ...actual, buildInsertUpdate: vi.fn(actual.buildInsertUpdate) };
});

// Fragment 0's tx assembly is covered in services/deploy-tx.test.ts; here the
// spy is what lets a test count deploy submissions and force a block-limit
// refusal. Everything else in the module stays real.
vi.mock('./services/deploy-tx.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./services/deploy-tx.ts')>();
  return { ...actual, submitDeploy: vi.fn(actual.submitDeploy) };
});

vi.mock('@midnight-ntwrk/midnight-js-network-id', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@midnight-ntwrk/midnight-js-network-id')
    >();
  return { ...actual, getNetworkId: vi.fn(() => 'undeployed') };
});

vi.mock('@midnight-ntwrk/wallet-sdk-address-format', () => {
  const codec = { encode: vi.fn(() => ({ toString: () => 'addr1stub' })) };
  return {
    ShieldedAddress: { codec },
    UnshieldedAddress: { codec },
    DustAddress: { codec },
  };
});

const SPLIT_CIRCUITS = ['approve', 'burn', 'charge', 'deposit', 'evict'];

/** The ledger parses a contract address as hex, so the fake one has to be. */
const SPLIT_ADDRESS = 'cd'.repeat(32);

/** The signing key `writeFixture` writes, and the committee member it implies. */
const FIXTURE_SIGNING_KEY = 'aa'.repeat(32);
const FIXTURE_VERIFYING_KEY = signatureVerifyingKey(FIXTURE_SIGNING_KEY);

/**
 * A real compiler-emitted key. The ledger checks its header when an insert is
 * built, so the fake zk-config provider and the fake chain both serve these
 * bytes.
 */
const VERIFIER_KEY = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL(
        './services/fixtures/counter-increment.verifier',
        import.meta.url,
      ),
    ),
  ),
);

/** The node's own wording for a pool rejection on an over-large extrinsic. */
const BLOCK_LIMIT_TEXT =
  '1010: Invalid Transaction: Transaction would exhaust the block limits';

/** Ledger-shaped contract state over a mutable on-chain circuit set. */
function chainState(circuits: readonly string[], counter: bigint) {
  return {
    operations: () => [...circuits],
    operation: (name: string) =>
      circuits.includes(name) ? { verifierKey: VERIFIER_KEY } : undefined,
    maintenanceAuthority: {
      committee: [FIXTURE_VERIFYING_KEY],
      threshold: 1,
      counter,
    },
  };
}

/** The dust indices `readDustTip` and `awaitDustSettled` read. */
interface DustView {
  tip: bigint;
  applied: bigint;
}

/** Minimal injected wallet: prepare skips sync, the fragment loop reads dust. */
function fragmentWallet(dust: DustView): MidnightWalletProvider {
  return {
    getCoinPublicKey: () => '0xDEPLOYER',
    wallet: {
      state: () =>
        Rx.of({
          dust: {
            state: {
              progress: {
                highestRelevantWalletIndex: dust.tip,
                appliedIndex: dust.applied,
              },
            },
          },
        }),
    },
  } as unknown as MidnightWalletProvider;
}

/** The real `MaintenanceUpdate` the loop built for insert `n`. */
function insertedUpdate(n: number): MaintenanceUpdate {
  const update = vi.mocked(buildInsertUpdate).mock.results[n]?.value;
  if (update === undefined) throw new Error(`no insert at index ${n}`);
  return update as MaintenanceUpdate;
}

/** Circuit ids of insert `n`, read off the signed update rather than the args. */
function insertedCircuits(n: number): string[] {
  return insertedUpdate(n).updates.map(
    (single) => (single as VerifierKeyInsert).operation as string,
  );
}

/**
 * Circuit ids of the update just built. A halving retry builds another update
 * without landing one, so the tx mocks read the latest attempt rather than
 * indexing by how many have landed.
 */
function lastInsertedCircuits(): string[] {
  return insertedCircuits(vi.mocked(buildInsertUpdate).mock.results.length - 1);
}

describe('Deployer fragmented deploy', () => {
  let fx: Fixture;
  let providers: FakeProviders;
  /** Circuits the fake chain reports, mutated as fragments land. */
  let onChain: string[];
  /** Landed maintenance updates, which is exactly the on-chain CMA counter. */
  let landedInserts: number;
  let dust: DustView;
  /** Verifier keys the fake artifact bundle reports. Overridable per test. */
  let artifactKeys: () => Promise<ReadonlyMap<string, Uint8Array>>;
  let declaredCircuits: readonly string[];

  /** A landed tx moves the dust stream on, and the wallet keeps up with it. */
  function spendDust(): void {
    dust.tip += 1n;
    dust.applied = dust.tip;
  }

  beforeEach(() => {
    fx = writeFixture();
    onChain = [];
    landedInserts = 0;
    dust = { tip: 0n, applied: 0n };
    artifactKeys = fakeVerifierKeys(SPLIT_CIRCUITS, VERIFIER_KEY);
    declaredCircuits = SPLIT_CIRCUITS;
    providers = fakeProviders();
    providers.publicDataProvider.queryContractState = vi.fn(async () =>
      chainState(onChain, BigInt(landedInserts)),
    );
    vi.mocked(buildProviders).mockImplementation(() => providers as never);
    vi.mocked(createUnprovenDeployTx).mockResolvedValue(
      fakeUnsubmittedDeploy() as never,
    );
    // Fragment 0 lands its circuits; each insert lands the batch it names.
    // Every landed tx spends dust, which the wallet then observes.
    vi.mocked(submitDeploy).mockImplementation(async ({ circuits }) => {
      onChain.push(...circuits);
      spendDust();
      return {
        address: SPLIT_ADDRESS,
        txId: '0xTX',
        unsubmitted: fakeUnsubmittedDeploy(),
      } as never;
    });
    vi.mocked(submitTxAsync).mockImplementation(async () => {
      onChain.push(...lastInsertedCircuits());
      landedInserts += 1;
      spendDust();
      return `0xINSERT${landedInserts}`;
    });
  });

  afterEach(() => {
    fx.cleanup();
    vi.clearAllMocks();
  });

  function splitDeployer(
    opts: { circuitsPerTx?: number; force?: boolean; logger?: Logger } = {},
    circuits: readonly string[] = SPLIT_CIRCUITS,
  ): Promise<Deployer> {
    if (circuits !== declaredCircuits) {
      declaredCircuits = circuits;
      artifactKeys = fakeVerifierKeys(circuits, VERIFIER_KEY);
    }
    vi.mocked(Artifact.load).mockResolvedValueOnce({
      artifactPath: '/fake/artifact',
      zkConfigPath: '/fake/artifact',
      compiledContract: { fake: 'compiled' },
      circuitNames: circuits,
      verifierKeys: () => artifactKeys(),
    } as never);
    return Deployer.prepare({
      contract: 'Counter',
      network: 'local',
      configPath: fx.configPath,
      logger: opts.logger ?? silentLogger,
      walletProvider: fragmentWallet(dust),
      circuitsPerTx: opts.circuitsPerTx,
      force: opts.force,
      // Short enough that a stuck wait fails the test instead of hanging it.
      txTimeoutMs: 200,
    });
  }

  /** Seed a head record so a rerun takes the resume or force path. */
  function seedHead(record: Record<string, unknown>): void {
    mkdirSync(join(fx.rootDir, 'deployments'), { recursive: true });
    writeFileSync(headPath(fx.rootDir), JSON.stringify({ Counter: record }));
  }

  function partialHead(
    circuitsOnChain: string[],
    circuitsPending: string[],
  ): Record<string, unknown> {
    return {
      status: 'partial',
      address: SPLIT_ADDRESS,
      txId: '0xTX',
      deployer: '0xDEPLOYER',
      artifact: 'Counter',
      circuitsOnChain,
      circuitsPending,
      submittedAt: '2026-09-01T00:00:00.000Z',
      txHash: '0xHASH',
      blockHeight: 1234,
    };
  }

  // INV-16, INV-29
  it('lands one deploy tx plus one insert per further fragment', async () => {
    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const result = await d.deploy();

    expect(submitDeploy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitDeploy).mock.calls[0]?.[0].circuits).toStrictEqual([
      'approve',
      'burn',
    ]);
    expect(submitTxAsync).toHaveBeenCalledTimes(2);
    expect(insertedCircuits(0)).toStrictEqual(['charge', 'deposit']);
    expect(insertedCircuits(1)).toStrictEqual(['evict']);
    expect(result.fragments).toBe(3);
    expect(result.circuits).toBe(5);
    expect(readHead(fx.rootDir).Counter?.status).toBe('confirmed');
  });

  // INV-14, INV-25, INV-28
  it('signs each insert for the recorded address at the on-chain counter and slot', async () => {
    await using d = await splitDeployer({ circuitsPerTx: 2 });
    await d.deploy();

    for (const n of [0, 1]) {
      const update = insertedUpdate(n);
      expect(update.address).toBe(SPLIT_ADDRESS);
      expect(update.counter).toBe(BigInt(n));
      const [slot, signature] = update.signatures[0] as [bigint, string];
      expect(slot).toBe(0n);
      expect(
        verifySignature(FIXTURE_VERIFYING_KEY, update.dataToSign, signature),
      ).toBe(true);
    }
  });

  // INV-25
  it('refuses to insert when the committee needs more than one signature', async () => {
    providers.publicDataProvider.queryContractState = vi.fn(async () => ({
      ...chainState(onChain, BigInt(landedInserts)),
      maintenanceAuthority: {
        committee: [FIXTURE_VERIFYING_KEY, 'other'],
        threshold: 2,
        counter: 0n,
      },
    }));

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain(
      'needs 2 maintenance signatures',
    );
    expect(submitTxAsync).not.toHaveBeenCalled();
  });

  // INV-25
  it('signs at this key slot when the committee is ordered differently', async () => {
    providers.publicDataProvider.queryContractState = vi.fn(async () => ({
      ...chainState(onChain, BigInt(landedInserts)),
      maintenanceAuthority: {
        committee: ['someone-else', FIXTURE_VERIFYING_KEY],
        threshold: 1,
        counter: BigInt(landedInserts),
      },
    }));

    await using d = await splitDeployer({ circuitsPerTx: 4 });
    await d.deploy();

    expect(insertedUpdate(0).signatures[0]?.[0]).toBe(1n);
  });

  // INV-17
  it('records progress from the chain read, never from the plan', async () => {
    const observed: { onChain: unknown; pending: unknown }[] = [];
    const submit = vi.mocked(submitTxAsync).getMockImplementation();
    vi.mocked(submitTxAsync).mockImplementation(async (...callArgs) => {
      const head = readHead(fx.rootDir).Counter;
      observed.push({
        onChain: head?.circuitsOnChain,
        pending: head?.circuitsPending,
      });
      return submit?.(...callArgs) as Promise<string>;
    });

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    await d.deploy();

    expect(observed).toStrictEqual([
      { onChain: ['approve', 'burn'], pending: ['charge', 'deposit', 'evict'] },
      { onChain: ['approve', 'burn', 'charge', 'deposit'], pending: ['evict'] },
    ]);
  });

  // INV-20
  it('leaves the single-fragment path without a chain read or an insert', async () => {
    await using d = await splitDeployer(undefined, ['approve']);
    const result = await d.deploy();

    expect(submitTxAsync).not.toHaveBeenCalled();
    expect(
      providers.publicDataProvider.queryContractState,
    ).not.toHaveBeenCalled();
    expect(result.fragments).toBe(1);
    expect(result.circuits).toBe(1);
    expect(readHead(fx.rootDir).Counter?.status).toBe('confirmed');
  });

  // INV-9
  it('halves fragment 0 on a block-limit refusal and retries', async () => {
    const sizes: number[] = [];
    vi.mocked(submitDeploy).mockImplementation(async ({ circuits }) => {
      sizes.push(circuits.length);
      if (circuits.length > 1) {
        throw new BlockLimitError(BLOCK_LIMIT_TEXT);
      }
      onChain.push(...circuits);
      spendDust();
      return {
        address: SPLIT_ADDRESS,
        txId: '0xTX',
        unsubmitted: fakeUnsubmittedDeploy(),
      } as never;
    });

    await using d = await splitDeployer(undefined, [
      'approve',
      'burn',
      'charge',
      'deposit',
    ]);
    await d.deploy();

    expect(sizes).toStrictEqual([4, 2, 1]);
  });

  // INV-9
  it('halves an insert batch on a block-limit refusal and retries', async () => {
    onChain = ['approve', 'burn'];
    seedHead(partialHead(['approve', 'burn'], ['charge', 'deposit', 'evict']));
    const sizes: number[] = [];
    const land = vi.mocked(submitTxAsync).getMockImplementation();
    vi.mocked(submitTxAsync).mockImplementation(async (...callArgs) => {
      const size = lastInsertedCircuits().length;
      sizes.push(size);
      if (size > 2) throw new Error(BLOCK_LIMIT_TEXT);
      return land?.(...callArgs) as Promise<string>;
    });

    await using d = await splitDeployer();
    const result = await d.deploy();

    expect(sizes).toStrictEqual([3, 1, 1, 1]);
    expect(result.circuits).toBe(5);
    expect(readHead(fx.rootDir).Counter?.status).toBe('confirmed');
  });

  // INV-9, INV-30
  it('reports an insert refused at one circuit as a resumable failure', async () => {
    onChain = ['approve', 'burn', 'charge', 'deposit'];
    seedHead(partialHead(['approve', 'burn', 'charge', 'deposit'], ['evict']));
    vi.mocked(submitTxAsync).mockRejectedValue(new Error(BLOCK_LIMIT_TEXT));

    await using d = await splitDeployer();
    const thrown = await d.deploy().catch((e: unknown) => e);

    // The contract is already deployed, so the exit is the resumable one and
    // the refusal rides along as the cause.
    expect(thrown).toBeInstanceOf(FragmentDeployError);
    const error = thrown as FragmentDeployError;
    expect(error.exitCode).toBe(8);
    expect(error.address).toBe(SPLIT_ADDRESS);
    expect(error.circuitsOnChain).toStrictEqual([
      'approve',
      'burn',
      'charge',
      'deposit',
    ]);
    expect(error.circuitsPending).toStrictEqual(['evict']);
    expect(error.cause).toBeInstanceOf(BlockLimitError);
    expect(readHead(fx.rootDir).Counter?.status).toBe('partial');
  });

  // INV-9
  it('does not halve when a budget was set explicitly', async () => {
    vi.mocked(submitDeploy).mockRejectedValue(
      new BlockLimitError(BLOCK_LIMIT_TEXT),
    );

    await using d = await splitDeployer({ circuitsPerTx: 4 });

    await expect(d.deploy()).rejects.toThrow(BlockLimitError);
    expect(submitDeploy).toHaveBeenCalledTimes(1);
  });

  // INV-21
  it('leaves no record and no private state when even one circuit is too large', async () => {
    vi.mocked(submitDeploy).mockRejectedValue(
      new BlockLimitError(BLOCK_LIMIT_TEXT),
    );

    await using d = await splitDeployer(undefined, ['approve', 'burn']);
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(BlockLimitError);
    expect((thrown as BlockLimitError).exitCode).toBe(7);
    expect(existsSync(headPath(fx.rootDir))).toBe(false);
    expect(providers.privateStateProvider.setSigningKey).not.toHaveBeenCalled();
    expect(providers.publicDataProvider.watchForTxData).not.toHaveBeenCalled();
  });

  // INV-9
  it('leaves a non-limit failure unretried', async () => {
    vi.mocked(submitDeploy).mockRejectedValue(
      new DeployTxFailedError('1010: Invalid Transaction: Custom error 103'),
    );

    await using d = await splitDeployer({ circuitsPerTx: 2 });

    await expect(d.deploy()).rejects.toThrow(DeployTxFailedError);
    expect(submitDeploy).toHaveBeenCalledTimes(1);
  });

  // INV-18
  it('persists private state once on a split deploy', async () => {
    await using d = await splitDeployer({ circuitsPerTx: 2 });
    await d.deploy();

    expect(providers.privateStateProvider.setSigningKey).toHaveBeenCalledTimes(
      1,
    );
  });

  // INV-19
  it('waits for the wallet to apply the deploy spend before the first insert', async () => {
    // The wallet stays at the mark taken before the deploy tx, so nothing may
    // be balanced against the same UTXO set.
    const deployed = vi.mocked(submitDeploy).getMockImplementation();
    vi.mocked(submitDeploy).mockImplementation(async (...callArgs) => {
      const result = await deployed?.(...callArgs);
      dust.applied = dust.tip - 1n;
      return result as never;
    });

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as Error).message).toContain('could double-spend');
    expect(submitTxAsync).not.toHaveBeenCalled();
    expect(readHead(fx.rootDir).Counter?.status).toBe('partial');
  });

  // INV-19
  it('waits for the wallet to apply each insert spend before the next', async () => {
    const land = vi.mocked(submitTxAsync).getMockImplementation();
    vi.mocked(submitTxAsync).mockImplementation(async (...callArgs) => {
      const txId = (await land?.(...callArgs)) as string;
      dust.applied = dust.tip - 1n;
      return txId;
    });

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect(submitTxAsync).toHaveBeenCalledTimes(1);
    expect(readHead(fx.rootDir).Counter?.status).toBe('partial');
  });

  // INV-19
  it('does not wait on the wallet after the last insert', async () => {
    const land = vi.mocked(submitTxAsync).getMockImplementation();
    vi.mocked(submitTxAsync).mockImplementation(async (...callArgs) => {
      const txId = (await land?.(...callArgs)) as string;
      // Only the final insert leaves the wallet behind; the run must still
      // finish, because nothing follows it.
      if (onChain.length === SPLIT_CIRCUITS.length) {
        dust.applied = dust.tip - 1n;
      }
      return txId;
    });

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const result = await d.deploy();

    expect(result.circuits).toBe(5);
  });

  // INV-30
  it('records the insert txId when it never sees the tx land', async () => {
    // Only the insert's watch hangs; the deploy tx still lands.
    const watch = providers.publicDataProvider.watchForTxData;
    providers.publicDataProvider.watchForTxData = vi.fn((txId: string) =>
      txId === '0xTX' ? watch(txId) : new Promise(() => {}),
    );

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as FragmentDeployError).txId).toBe('0xINSERT1');
    const written = readHead(fx.rootDir).Counter;
    expect(written?.status).toBe('partial');
    expect(written?.pendingTxId).toBe('0xINSERT1');
  });

  // INV-29
  it('settles an insert the previous run left in flight before planning', async () => {
    onChain = ['approve', 'burn', 'charge', 'deposit'];
    landedInserts = 1;
    seedHead({
      ...partialHead(['approve', 'burn'], ['charge', 'deposit', 'evict']),
      pendingTxId: '0xLEFTOVER',
    });

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const result = await d.deploy();

    expect(providers.publicDataProvider.watchForTxData).toHaveBeenCalledWith(
      '0xLEFTOVER',
    );
    // Its circuits are on chain, so only the last one is left to insert.
    expect(submitTxAsync).toHaveBeenCalledTimes(1);
    expect(insertedCircuits(0)).toStrictEqual(['evict']);
    expect(result.circuits).toBe(5);
  });

  // INV-29
  it('carries on when the insert left in flight never landed', async () => {
    onChain = ['approve', 'burn'];
    seedHead({
      ...partialHead(['approve', 'burn'], ['charge', 'deposit', 'evict']),
      pendingTxId: '0xLOST',
    });
    const watch = providers.publicDataProvider.watchForTxData;
    providers.publicDataProvider.watchForTxData = vi.fn(
      async (txId: string) => {
        if (txId === '0xLOST') throw new Error('never seen');
        return watch(txId);
      },
    );

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const result = await d.deploy();

    expect(result.circuits).toBe(5);
    expect(readHead(fx.rootDir).Counter?.status).toBe('confirmed');
  });

  // INV-18
  it('stores the signing key on a resume when the private state has none', async () => {
    onChain = [...SPLIT_CIRCUITS];
    seedHead(partialHead(SPLIT_CIRCUITS, []));
    providers.privateStateProvider.getSigningKey = vi.fn(async () => null);

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    await d.deploy();

    expect(providers.privateStateProvider.setSigningKey).toHaveBeenCalledWith(
      SPLIT_ADDRESS,
      FIXTURE_SIGNING_KEY,
    );
  });

  // INV-6
  it('takes the budget from [contracts.X].circuits_per_tx', async () => {
    fx.cleanup();
    fx = writeFixture({ circuitsPerTx: 2 });

    await using d = await splitDeployer();
    const result = await d.deploy();

    expect(vi.mocked(submitDeploy).mock.calls[0]?.[0].circuits).toStrictEqual([
      'approve',
      'burn',
    ]);
    expect(insertedCircuits(0)).toStrictEqual(['charge', 'deposit']);
    expect(result.fragments).toBe(3);
  });

  // INV-6
  it('lets the programmatic budget beat the TOML one', async () => {
    fx.cleanup();
    fx = writeFixture({ circuitsPerTx: 2 });

    await using d = await splitDeployer({ circuitsPerTx: 4 });
    await d.deploy();

    expect(vi.mocked(submitDeploy).mock.calls[0]?.[0].circuits).toHaveLength(4);
  });

  // INV-2
  it('refuses a resume whose record names a txHash the chain disagrees with', async () => {
    onChain = ['approve', 'burn'];
    seedHead({
      ...partialHead(['approve', 'burn'], ['charge', 'deposit', 'evict']),
      txHash: '0xSOMEONEELSE',
    });

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain('0xSOMEONEELSE');
    expect(submitTxAsync).not.toHaveBeenCalled();
  });

  // INV-30
  it('reports a deploy tx the chain says did not succeed', async () => {
    seedHead(partialHead(['approve'], ['burn']));
    providers.publicDataProvider.watchForDeployTxData = vi.fn(async () => ({
      status: 'FailEntirely',
      txId: '0xTX',
      txHash: '0xHASH',
      blockHeight: 1,
    }));

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as Error).message).toContain('did not succeed');
  });

  // INV-30
  it('reports an unreadable chain state as the resumable error', async () => {
    seedHead(partialHead(['approve'], ['burn']));
    providers.publicDataProvider.queryContractState = vi.fn(async () => {
      throw new Error('indexer said no');
    });

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as Error).message).toContain('could not be read');
  });

  // INV-27
  it('still reports a missing contract when the deploy tx never lands', async () => {
    seedHead(partialHead(['approve'], ['burn']));
    // Nothing at the address: no state to read and no deploy tx to settle.
    providers.publicDataProvider.queryContractState = vi.fn(async () => null);
    providers.publicDataProvider.watchForDeployTxData = vi.fn(
      () => new Promise(() => {}),
    );

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as Error).message).toContain('no contract exists there');
  });

  // INV-29
  it('clears the pending insert when the node ruled the tx failed', async () => {
    const watch = providers.publicDataProvider.watchForTxData;
    providers.publicDataProvider.watchForTxData = vi.fn(async (txId: string) =>
      txId === '0xTX'
        ? watch(txId)
        : { ...(await watch(txId)), status: 'FailEntirely' },
    );

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    await d.deploy().catch(() => undefined);

    const written = readHead(fx.rootDir).Counter;
    expect(written?.status).toBe('partial');
    expect(written).not.toHaveProperty('pendingTxId');
  });

  // INV-30
  it('reports a deploy tx it can neither settle nor read from the record', async () => {
    onChain = ['approve', 'burn'];
    const legacy = partialHead(['approve', 'burn'], ['charge']);
    delete legacy.txHash;
    delete legacy.blockHeight;
    seedHead(legacy);
    // Chain state exists, so the resume guard passes, but the deploy tx never
    // settles and the record has nothing to fall back on.
    providers.publicDataProvider.watchForDeployTxData = vi.fn(
      () => new Promise(() => {}),
    );

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as Error).message).toContain('could not be identified');
    expect(submitTxAsync).not.toHaveBeenCalled();
  });

  // INV-30
  it('keeps the insert failure when the progress write also fails', async () => {
    const watch = providers.publicDataProvider.watchForTxData;
    providers.publicDataProvider.watchForTxData = vi.fn((txId: string) =>
      txId === '0xTX' ? watch(txId) : new Promise(() => {}),
    );
    const { logger, lines } = recordingLogger();
    // Corrupt the ledger so the progress rewrite that follows the timeout
    // cannot land either.
    vi.mocked(submitTxAsync).mockImplementation(async () => {
      writeFileSync(headPath(fx.rootDir), '{not json');
      return '0xINSERT1';
    });

    await using d = await splitDeployer({ circuitsPerTx: 2, logger });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as FragmentDeployError).txId).toBe('0xINSERT1');
    expect(lines()).toContain('Could not record progress');
  });

  // INV-22
  it('keeps the signing key out of a failed deploy and its --json output', async () => {
    vi.mocked(submitTxAsync).mockRejectedValue(new Error('out of dust'));
    const { logger, lines } = recordingLogger();

    await using d = await splitDeployer({ circuitsPerTx: 2, logger });
    const thrown = (await d.deploy().catch((e: unknown) => e)) as Error;

    expect(thrown.message).not.toContain(FIXTURE_SIGNING_KEY);
    expect(String(thrown)).not.toContain(FIXTURE_SIGNING_KEY);
    expect(
      JSON.stringify({ ...thrown, message: thrown.message }),
    ).not.toContain(FIXTURE_SIGNING_KEY);
    expect(lines()).not.toContain(FIXTURE_SIGNING_KEY);
    expect(readFileSync(headPath(fx.rootDir), 'utf8')).not.toContain(
      FIXTURE_SIGNING_KEY,
    );
  });

  // INV-26, INV-29
  it('resumes a partial head without a second deploy tx', async () => {
    onChain = ['approve', 'burn'];
    landedInserts = 0;
    seedHead(partialHead(['approve', 'burn'], ['charge', 'deposit', 'evict']));

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const result = await d.deploy();

    expect(submitDeploy).not.toHaveBeenCalled();
    expect(submitTxAsync).toHaveBeenCalledTimes(2);
    expect(result.address).toBe(SPLIT_ADDRESS);
    // The deploy tx is not re-awaited; its identifiers ride the record.
    expect(
      providers.publicDataProvider.watchForTxData,
    ).not.toHaveBeenCalledWith('0xTX');
    expect(result.txHash).toBe('0xHASH');
    expect(result.blockHeight).toBe(1234);
    expect(readHead(fx.rootDir).Counter?.status).toBe('confirmed');
  });

  // INV-16
  it('resolves the deploy tx identifiers from chain when the record lacks them', async () => {
    onChain = [...SPLIT_CIRCUITS];
    const legacy = partialHead(SPLIT_CIRCUITS, []);
    delete legacy.txHash;
    delete legacy.blockHeight;
    seedHead(legacy);

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const result = await d.deploy();

    expect(
      providers.publicDataProvider.watchForDeployTxData,
    ).toHaveBeenCalledWith(SPLIT_ADDRESS);
    expect(result.txHash).toBe('0xHASH');
    expect(result.blockHeight).toBe(1234);
    expect(readHead(fx.rootDir).Counter?.status).toBe('confirmed');
  });

  // INV-29
  it('counts inserts from the interrupted run in the fragment total', async () => {
    onChain = ['approve', 'burn', 'charge', 'deposit'];
    // Two updates already landed before the interruption.
    landedInserts = 2;
    seedHead(partialHead(['approve', 'burn', 'charge', 'deposit'], ['evict']));

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const result = await d.deploy();

    expect(submitTxAsync).toHaveBeenCalledTimes(1);
    expect(result.fragments).toBe(4);
  });

  // INV-18
  it('does not rewrite private state on a resume', async () => {
    onChain = [...SPLIT_CIRCUITS];
    seedHead(partialHead(SPLIT_CIRCUITS, []));

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    await d.deploy();

    expect(providers.privateStateProvider.setSigningKey).not.toHaveBeenCalled();
  });

  // INV-10
  it('submits no insert when the chain already holds every circuit', async () => {
    onChain = [...SPLIT_CIRCUITS];
    seedHead(partialHead(SPLIT_CIRCUITS, []));

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    await d.deploy();

    expect(submitTxAsync).not.toHaveBeenCalled();
  });

  // INV-27(a)
  it('refuses to resume against an address with no contract', async () => {
    seedHead(partialHead(['approve'], ['burn']));
    providers.publicDataProvider.queryContractState = vi.fn(async () => null);

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(ConfigError);
    expect(submitDeploy).not.toHaveBeenCalled();
    expect(submitTxAsync).not.toHaveBeenCalled();
  });

  // INV-27(b)
  it('refuses to resume a contract maintained by a foreign committee', async () => {
    onChain = ['approve'];
    seedHead(partialHead(['approve'], ['burn']));
    providers.publicDataProvider.queryContractState = vi.fn(async () => ({
      ...chainState(onChain, 0n),
      maintenanceAuthority: {
        committee: ['SOMEONE-ELSE'],
        threshold: 1,
        counter: 1n,
      },
    }));

    await using d = await splitDeployer({ circuitsPerTx: 2 });

    await expect(d.deploy()).rejects.toThrow(ConfigError);
    expect(submitTxAsync).not.toHaveBeenCalled();
  });

  // INV-27(c)
  it('refuses to resume a contract carrying a foreign verifier key', async () => {
    onChain = ['approve'];
    seedHead(partialHead(['approve'], ['burn']));
    providers.publicDataProvider.queryContractState = vi.fn(async () => ({
      ...chainState(onChain, 0n),
      operation: () => ({ verifierKey: new Uint8Array([9, 9]) }),
    }));

    await using d = await splitDeployer({ circuitsPerTx: 2 });

    await expect(d.deploy()).rejects.toThrow(ConfigError);
    expect(submitTxAsync).not.toHaveBeenCalled();
  });

  // INV-26
  it('rotates a partial head into history and redeploys under --force', async () => {
    seedHead(partialHead(['approve'], ['burn']));

    await using d = await splitDeployer({ circuitsPerTx: 2, force: true });
    await d.deploy();

    expect(submitDeploy).toHaveBeenCalledTimes(1);
    const history = JSON.parse(
      readFileSync(
        join(fx.rootDir, 'deployments', 'local.history.json'),
        'utf8',
      ),
    );
    expect(history.Counter[0]).toMatchObject({ status: 'partial' });
  });

  // INV-26
  it('refuses a fresh deploy over a partial head, keeping its exit code', async () => {
    seedHead(partialHead(['approve'], ['burn']));
    // A chain read that would fail the resume guard, so the refusal has to
    // come from the record check rather than from a later gate.
    providers.publicDataProvider.queryContractState = vi.fn(async () => null);

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect((thrown as ConfigError).exitCode).toBe(2);
    expect(submitDeploy).not.toHaveBeenCalled();
  });

  // INV-30
  it('reports a failed insert as FragmentDeployError and keeps the head partial', async () => {
    vi.mocked(submitTxAsync).mockRejectedValue(new Error('out of dust'));

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    const error = thrown as FragmentDeployError;
    expect(error.exitCode).toBe(8);
    expect(error.address).toBe(SPLIT_ADDRESS);
    expect(error.circuitsOnChain).toStrictEqual(['approve', 'burn']);
    expect(error.circuitsPending).toStrictEqual(['charge', 'deposit', 'evict']);
    expect(readHead(fx.rootDir).Counter?.status).toBe('partial');
  });

  // INV-11, INV-30
  it('refuses to confirm when a landed key does not match the artifact', async () => {
    // Chain reports a different key for the last circuit than the artifact has.
    const genuine = providers.publicDataProvider.queryContractState;
    providers.publicDataProvider.queryContractState = vi.fn(async () => {
      const state = (await genuine()) as ReturnType<typeof chainState>;
      return {
        ...state,
        operation: (name: string) =>
          name === 'evict'
            ? { verifierKey: new Uint8Array([0, 0]) }
            : state.operation(name),
      };
    });

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(FragmentDeployError);
    expect((thrown as Error).message).toContain('different verifier key');
    expect(readHead(fx.rootDir).Counter?.status).toBe('partial');
  });

  // INV-10
  it('skips a fragment whose circuits already landed with an earlier insert', async () => {
    // The first insert lands its own batch plus everything after it, so the
    // next fragment has nothing left to insert.
    vi.mocked(submitTxAsync).mockImplementation(async () => {
      onChain.push(...SPLIT_CIRCUITS.filter((c) => !onChain.includes(c)));
      landedInserts += 1;
      dust.applied = dust.tip + 1n;
      return '0xINSERT';
    });

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const result = await d.deploy();

    expect(submitTxAsync).toHaveBeenCalledTimes(1);
    expect(result.circuits).toBe(5);
  });

  // INV-6
  it('inserts every remaining circuit in one batch on a resume with no budget', async () => {
    onChain = ['approve', 'burn'];
    seedHead(partialHead(['approve', 'burn'], ['charge', 'deposit', 'evict']));

    await using d = await splitDeployer();
    await d.deploy();

    expect(submitTxAsync).toHaveBeenCalledTimes(1);
    expect(insertedCircuits(0)).toStrictEqual(['charge', 'deposit', 'evict']);
  });

  // INV-16
  it('keeps a ledger-write failure inside the fragment loop as a ledger error', async () => {
    const land = vi.mocked(submitTxAsync).getMockImplementation();
    vi.mocked(submitTxAsync).mockImplementation(async (...callArgs) => {
      const txId = (await land?.(...callArgs)) as string;
      // Corrupt the ledger after the first insert so the progress rewrite
      // fails while the contract is already partially deployed.
      if (landedInserts === 1) {
        writeFileSync(headPath(fx.rootDir), '{not json');
      }
      return txId;
    });

    await using d = await splitDeployer({ circuitsPerTx: 2 });
    const thrown = await d.deploy().catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(DeploymentsFileError);
    expect(thrown).not.toBeInstanceOf(FragmentDeployError);
  });

  // INV-22
  it('logs no signing-key hex on a split deploy', async () => {
    const { logger, lines } = recordingLogger();

    await using d = await splitDeployer({ circuitsPerTx: 2, logger });
    await d.deploy();

    expect(lines()).not.toBe('');
    expect(lines()).not.toContain(FIXTURE_SIGNING_KEY);
  });

  // INV-22
  it('logs no signing-key hex on a resume', async () => {
    onChain = ['approve', 'burn'];
    seedHead(partialHead(['approve', 'burn'], ['charge', 'deposit', 'evict']));
    const { logger, lines } = recordingLogger();

    await using d = await splitDeployer({ circuitsPerTx: 2, logger });
    await d.deploy();

    expect(lines()).toContain(FIXTURE_VERIFYING_KEY);
    expect(lines()).not.toContain(FIXTURE_SIGNING_KEY);
  });

  // INV-6
  it.each([0, -1, 1.5])(
    'rejects a budget of %s before starting the proof server',
    async (circuitsPerTx) => {
      await expect(splitDeployer({ circuitsPerTx })).rejects.toThrow(
        ConfigError,
      );
      expect(ProofServer.start).not.toHaveBeenCalled();
    },
  );
});
