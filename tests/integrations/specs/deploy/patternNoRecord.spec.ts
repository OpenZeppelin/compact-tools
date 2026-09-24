import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  inMemoryPrivateStateProvider,
  syncWallet,
} from '@midnight-ntwrk/testkit-js';
import {
  Deployer,
  type DeployResult,
} from '@openzeppelin/compact-deployer/deployer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testLogger } from '../../_harness/logger.ts';
import {
  localNetworkConfig,
  setupLocalNetwork,
} from '../../_harness/network.ts';
import {
  ARTIFACTS_DIR,
  ROOT_DIR,
  requireArtifact,
} from '../../_harness/paths.ts';
import { getSharedPool } from '../../_harness/walletPool.ts';

/**
 * Spec: `Fragmented` deployed by name through a pattern entry, with its
 * private state and witnesses passed in code and `record: false`. The pattern
 * pins `circuits_per_tx = 5`, so the split is the one `fragmented.spec.ts`
 * asserts.
 */

const CONFIG_PATH = resolve(ROOT_DIR, 'pattern-no-record.compact.toml');

/** `[profile].deployments_dir` of that config. */
const DEPLOYMENTS_DIR = resolve(ROOT_DIR, 'deployments/pattern-no-record');

/** The pattern's `private_state_id` after `{name}` expansion. */
const PRIVATE_STATE_ID = 'Fragmented-private-state';

const IN_CODE_STATE = { source: 'in-code', seed: 42n };

/** Ceiling for the deploy tx plus three inserts. */
const DEPLOY_BUDGET_MS = 600_000;

/** Every circuit `Fragmented.compact` declares, sorted as the planner sorts. */
const CIRCUITS = Array.from(
  { length: 20 },
  (_unused, i) => `step${String(i + 1).padStart(2, '0')}`,
).sort();

describe('compact-deploy — pattern entry, in-code state, no ledger', () => {
  const env = localNetworkConfig();
  const provider = indexerPublicDataProvider(env.indexer, env.indexerWS);
  const zkConfig = new NodeZkConfigProvider<string>(
    resolve(ARTIFACTS_DIR, 'Fragmented'),
  );
  const privateStateProvider = inMemoryPrivateStateProvider();
  let result: DeployResult;

  beforeAll(async () => {
    requireArtifact('Fragmented');
    rmSync(DEPLOYMENTS_DIR, { recursive: true, force: true });
    setupLocalNetwork();
    const wallet = await getSharedPool().signerFor('DEPLOYER');
    await syncWallet(wallet.wallet);
    await using deployer = await Deployer.prepare({
      contract: 'Fragmented',
      network: 'local',
      configPath: CONFIG_PATH,
      logger: testLogger(),
      walletProvider: wallet,
      privateStateProvider,
      initialPrivateState: IN_CODE_STATE,
      // Fragmented declares no witnesses.
      witnesses: {},
      record: false,
    });
    result = await deployer.deploy();
  }, DEPLOY_BUDGET_MS);

  afterAll(() => {
    rmSync(DEPLOYMENTS_DIR, { recursive: true, force: true });
  });

  it('should write no deployments file', () => {
    expect(result.deploymentsFile).toBe('');
    expect(existsSync(DEPLOYMENTS_DIR)).toBe(false);
  });

  it('should land the deploy plus one insert per further fragment', () => {
    expect(result.artifact).toBe('Fragmented');
    expect(result.fragments).toBe(4);
    expect(result.circuits).toBe(20);
  });

  it('should hold exactly the artifact circuits with byte-equal verifier keys', async () => {
    const state = await provider.queryContractState(result.address);
    if (state === null) throw new Error(`no contract at ${result.address}`);
    const onChain = state
      .operations()
      .map((op) => (typeof op === 'string' ? op : Buffer.from(op).toString()))
      .sort();

    expect(onChain).toStrictEqual(CIRCUITS);
    for (const name of CIRCUITS) {
      expect(state.operation(name)?.verifierKey).toStrictEqual(
        new Uint8Array(await zkConfig.getVerifierKey(name)),
      );
    }
  });

  it('should store the in-code private state under the pattern id', async () => {
    await expect(
      privateStateProvider.get(PRIVATE_STATE_ID),
    ).resolves.toStrictEqual(IN_CODE_STATE);
  });
});
