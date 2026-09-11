import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import { syncWallet } from '@midnight-ntwrk/testkit-js';
import {
  Deployer,
  type DeployResult,
} from '@openzeppelin/compact-deployer/deployer';
import {
  BlockLimitError,
  FragmentDeployError,
} from '@openzeppelin/compact-deployer/errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type FixtureContract,
  harnessPrivateStateProvider,
} from '../../_harness/deployer.ts';
import { testLogger } from '../../_harness/logger.ts';
import {
  localNetworkConfig,
  setupLocalNetwork,
} from '../../_harness/network.ts';
import {
  ARTIFACTS_DIR,
  CONFIG_PATH,
  DEPLOYMENTS_DIR,
  ROOT_DIR,
  requireArtifact,
  wipeDeployments,
} from '../../_harness/paths.ts';
import { getSharedPool } from '../../_harness/walletPool.ts';

/**
 * Spec: `Fragmented` (20 circuits, `circuits_per_tx = 5`) is too large for one
 * deploy transaction, so the deployer splits it into a pruned deploy plus
 * batched verifier-key inserts. Everything runs against the live local stack,
 * and every assertion reads chain state through the indexer rather than
 * through deployer internals.
 *
 * One wallet for the whole file: the deploys here are sequential, and sharing
 * an alias is what keeps the UTXO view consistent across them.
 */

const HEAD_PATH = resolve(DEPLOYMENTS_DIR, 'local.json');

/** Ceiling per describe: each deploy is one tx plus up to three inserts. */
const DEPLOY_BUDGET_MS = 600_000;

/** Every circuit `Fragmented.compact` declares, sorted as the planner sorts. */
const CIRCUITS = Array.from(
  { length: 20 },
  (_unused, i) => `step${String(i + 1).padStart(2, '0')}`,
).sort();

/** One chain read, reduced to what the invariants talk about. */
interface Snapshot {
  circuits: string[];
  verifierKeys: Map<string, Uint8Array>;
  counter: bigint;
  committee: string[];
  threshold: number;
}

function publicProvider(): PublicDataProvider {
  const env = localNetworkConfig();
  return indexerPublicDataProvider(env.indexer, env.indexerWS);
}

async function snapshotOf(
  provider: PublicDataProvider,
  address: string,
): Promise<Snapshot> {
  const state = await provider.queryContractState(address);
  if (state === null) throw new Error(`no contract state at ${address}`);
  const circuits = state
    .operations()
    .map((op) => (typeof op === 'string' ? op : Buffer.from(op).toString()))
    .sort();
  const verifierKeys = new Map<string, Uint8Array>();
  for (const name of circuits) {
    const op = state.operation(name);
    if (op !== undefined) verifierKeys.set(name, op.verifierKey);
  }
  const authority = state.maintenanceAuthority;
  return {
    circuits,
    verifierKeys,
    counter: authority.counter,
    committee: [...authority.committee],
    threshold: authority.threshold,
  };
}

/**
 * Counts submissions and can interrupt one before it is balanced.
 *
 * Wrapping the wallet is the only seam a spec has for driving the deployer's
 * failure paths from outside. The cut has to land on `balanceTx`, not on
 * `submitTx`: a transaction that is balanced and then not submitted leaves the
 * wallet holding dust it believes is spent, and the next `balanceTx` waits for
 * change that never arrives.
 */
interface SubmitTap {
  wallet: MidnightWalletProvider;
  /** Transactions the deployer got onto the node. */
  submitted: number;
  /** Wall-clock gap between consecutive submissions, in ms. */
  gaps: number[];
}

function tapSubmissions(
  wallet: MidnightWalletProvider,
  failBalanceFrom?: number,
): SubmitTap {
  const tap: SubmitTap = { wallet, submitted: 0, gaps: [] };
  let balanced = 0;
  let previous: number | undefined;
  const balanceTx = wallet.balanceTx.bind(wallet);
  const submitTx = wallet.submitTx.bind(wallet);
  const proxy = Object.create(wallet) as MidnightWalletProvider;
  proxy.balanceTx = async (
    ...args: Parameters<MidnightWalletProvider['balanceTx']>
  ) => {
    balanced += 1;
    if (failBalanceFrom !== undefined && balanced >= failBalanceFrom) {
      throw new Error(`balancing ${balanced} interrupted by the spec`);
    }
    return balanceTx(...args);
  };
  proxy.submitTx = async (
    ...args: Parameters<MidnightWalletProvider['submitTx']>
  ) => {
    tap.submitted += 1;
    const now = Date.now();
    if (previous !== undefined) tap.gaps.push(now - previous);
    previous = now;
    return submitTx(...args);
  };
  tap.wallet = proxy;
  return tap;
}

/** The suite's funded wallet for this file, synced before every deploy. */
async function fragmentWallet(): Promise<MidnightWalletProvider> {
  setupLocalNetwork();
  const wallet = await getSharedPool().signerFor('DEPLOYER');
  await syncWallet(wallet.wallet);
  return wallet;
}

async function deploy(
  contract: FixtureContract,
  wallet: MidnightWalletProvider,
): Promise<DeployResult> {
  await using deployer = await Deployer.prepare({
    contract,
    network: 'local',
    configPath: CONFIG_PATH,
    logger: testLogger(),
    walletProvider: wallet,
    privateStateProvider: harnessPrivateStateProvider(),
  });
  return deployer.deploy();
}

async function readHead(): Promise<Record<string, Record<string, unknown>>> {
  return JSON.parse(await readFile(HEAD_PATH, 'utf8'));
}

function signingKeyOf(contract: string): Promise<string> {
  return readFile(
    resolve(ROOT_DIR, 'fixtures/signingkeys', `${contract}.signingkey`),
    'utf8',
  ).then((hex) => hex.trim().replace(/^0x/i, ''));
}

describe('compact-deploy — Fragmented splits across transactions', () => {
  const provider = publicProvider();
  const zkConfig = new NodeZkConfigProvider<string>(
    resolve(ARTIFACTS_DIR, 'Fragmented'),
  );
  let result: DeployResult;
  let landed: Snapshot;
  let gaps: number[] = [];
  let elapsedMs = 0;

  beforeAll(async () => {
    requireArtifact('Fragmented');
    wipeDeployments();
    const tap = tapSubmissions(await fragmentWallet());
    const started = Date.now();
    result = await deploy('Fragmented', tap.wallet);
    elapsedMs = Date.now() - started;
    gaps = tap.gaps;
    landed = await snapshotOf(provider, result.address);
    testLogger().warn(
      { elapsedMs, gaps, fragments: result.fragments },
      'fragmented deploy: runtime, per-insert gaps, transaction count',
    );
  }, DEPLOY_BUDGET_MS);

  afterAll(() => {
    wipeDeployments();
  });

  // INV-1, INV-14, INV-16, INV-25, INV-28
  it('lands the deploy plus one insert per further fragment and confirms', async () => {
    expect(result.fragments).toBe(4);
    expect(result.circuits).toBe(20);

    const head = await readHead();
    expect(head.Fragmented).toStrictEqual({
      status: 'confirmed',
      address: result.address,
      txId: result.txId,
      txHash: result.txHash,
      blockHeight: result.blockHeight,
      deployer: result.deployer,
      artifact: 'Fragmented',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  // INV-11, INV-15
  it('holds exactly the artifact circuits with byte-equal verifier keys', async () => {
    expect(landed.circuits).toStrictEqual(CIRCUITS);
    for (const name of CIRCUITS) {
      expect(landed.verifierKeys.get(name)).toStrictEqual(
        new Uint8Array(await zkConfig.getVerifierKey(name)),
      );
    }
  });

  // INV-15, INV-28
  it('advances the maintenance counter once per insert and leaves the authority alone', () => {
    // The counter is 0 at deploy and rises by one per landed update, so a
    // four-transaction deploy ends at 3.
    expect(landed.counter).toBe(3n);
    expect(landed.threshold).toBe(1);
    expect(landed.committee).toHaveLength(1);
  });

  // INV-19
  it('clears the dust gate between inserts without approaching the ceiling', () => {
    // Each gap covers one insert: build, prove, submit, finalize, indexer
    // catch-up and the dust wait. The claim is only that it is nowhere near
    // the 600 s transaction ceiling.
    expect(gaps).toHaveLength(3);
    for (const gap of gaps) expect(gap).toBeLessThan(120_000);
  });

  // INV-22
  it('writes no signing-key hex into the deployments ledger', async () => {
    const signingKey = await signingKeyOf('Fragmented');

    expect(signingKey).toMatch(/^[0-9a-f]{64}$/i);
    expect(await readFile(HEAD_PATH, 'utf8')).not.toContain(signingKey);
  });
});

describe('compact-deploy — Fragmented resumes an interrupted split', () => {
  const provider = publicProvider();
  let stopped: FragmentDeployError;
  let partial: Record<string, unknown>;
  let resumed: DeployResult;
  let submissions = 0;

  beforeAll(async () => {
    requireArtifact('Fragmented');
    wipeDeployments();
    // Fail the second submission: the deploy tx lands, the first insert does
    // not, which is the window a resume has to pick up from.
    const tap = tapSubmissions(await fragmentWallet(), 2);
    stopped = (await deploy('Fragmented', tap.wallet).catch(
      (e: unknown) => e,
    )) as FragmentDeployError;
    partial = (await readHead()).Fragmented as Record<string, unknown>;
    submissions = tap.submitted;

    resumed = await deploy('Fragmented', await fragmentWallet());
  }, DEPLOY_BUDGET_MS);

  afterAll(() => {
    wipeDeployments();
  });

  // INV-17, INV-30
  it('stops with a resumable error and a partial record naming fragment 0', () => {
    expect(stopped).toBeInstanceOf(FragmentDeployError);
    expect(stopped.exitCode).toBe(8);
    // The deploy tx landed; the first insert never reached the node.
    expect(submissions).toBe(1);
    expect(partial.status).toBe('partial');
    expect(partial.address).toBe(stopped.address);
    expect(partial.circuitsOnChain).toStrictEqual(CIRCUITS.slice(0, 5));
    expect(partial.circuitsPending).toStrictEqual(CIRCUITS.slice(5));
  });

  // INV-26, INV-29
  it('finishes at the same address without a second deploy transaction', async () => {
    expect(resumed.address).toBe(partial.address);
    expect(resumed.txId).toBe(partial.txId);
    expect(resumed.txHash).toBe(partial.txHash);
    expect(resumed.circuits).toBe(20);
    expect(resumed.fragments).toBe(4);

    const head = await readHead();
    expect(head.Fragmented?.status).toBe('confirmed');
    expect(head.Fragmented?.address).toBe(partial.address);
    expect(
      (await snapshotOf(provider, resumed.address)).circuits,
    ).toStrictEqual(CIRCUITS);
  });
});

describe('compact-deploy — Fragmented with no configured budget', () => {
  let outcome: DeployResult | Error;
  let submissions = 0;

  beforeAll(async () => {
    requireArtifact('Fragmented');
    wipeDeployments();
    const tap = tapSubmissions(await fragmentWallet());
    outcome = await deploy('FragmentedNoBudget', tap.wallet).catch(
      (e: unknown) => e as Error,
    );
    submissions = tap.submitted;
    testLogger().warn(
      {
        submissions,
        fragments: outcome instanceof Error ? undefined : outcome.fragments,
        error: outcome instanceof Error ? outcome.name : undefined,
      },
      'no-budget deploy: submissions and the split the node forced',
    );
  }, DEPLOY_BUDGET_MS);

  afterAll(() => {
    wipeDeployments();
  });

  // INV-9, INV-21
  it('either lands the whole contract in one transaction or halves into it', async () => {
    if (outcome instanceof Error) {
      // A single circuit was still refused, so nothing may have been written.
      expect(outcome).toBeInstanceOf(BlockLimitError);
      expect((outcome as BlockLimitError).exitCode).toBe(7);
      return;
    }
    expect(outcome.circuits).toBe(20);
    const head = await readHead();
    expect(head.FragmentedNoBudget?.status).toBe('confirmed');
  });
});
