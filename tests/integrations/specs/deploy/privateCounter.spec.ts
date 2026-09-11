import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inMemoryPrivateStateProvider } from '@midnight-ntwrk/testkit-js';
import type { DeployResult } from '@openzeppelin/compact-deployer/deployer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFixture } from '../../_harness/deployer.ts';
import {
  DEPLOYMENTS_DIR,
  requireArtifact,
  wipeDeployments,
} from '../../_harness/paths.ts';

/**
 * Spec: the `PrivateCounter` fixture exercises two deploy-pipeline
 * paths the minimal `Counter` doesn't:
 *
 *  1. **`init_private_state`** — the deployer threads `privateStateId` +
 *     `initialPrivateState` into the contract-deploy options and, once
 *     the tx confirms, writes the seed into the private-state provider.
 *
 *  2. **Witnesses-module resolution** — `compact.toml` references
 *     `witnesses = { module = "...PrivateCounter.witness.ts", export =
 *     "PrivateCounterWitnesses" }`. `Artifact.load` resolves the export
 *     via Node's dynamic `import()`, calls the factory, and threads the
 *     impls into the compiled contract.
 *
 * The spec owns the private-state provider so it can read the seed back
 * after the deploy instead of inferring it from a green result.
 *
 * Prereq: `make compile` must have produced the `PrivateCounter`
 * artifact directory.
 */

/** `[contracts.PrivateCounter].private_state_id` in `compact.toml`. */
const PRIVATE_STATE_ID = 'private-counter-state';

/** `fixtures/initstates/PrivateCounter.json`, after the bigint revival. */
const SEEDED_PRIVATE_STATE = { delta: 7n };

describe('compact-deploy — PrivateCounter exercises private-state + witnesses-module paths', () => {
  const HEAD_PATH = resolve(DEPLOYMENTS_DIR, 'local.json');
  const privateStateProvider = inMemoryPrivateStateProvider();
  let result: DeployResult;

  beforeAll(async () => {
    requireArtifact('PrivateCounter');
    wipeDeployments();
    result = await deployFixture('PrivateCounter', 'CHARLIE', {
      privateStateProvider,
    });
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should return every on-chain identifier for the finalized tx', () => {
    expect(result).toStrictEqual({
      contractName: 'PrivateCounter',
      network: 'local',
      address: expect.stringMatching(/^[0-9a-f]+$/i),
      txId: expect.stringMatching(/^[0-9a-f]+$/i),
      txHash: expect.stringMatching(/^[0-9a-f]+$/i),
      blockHeight: expect.any(Number),
      deployer: expect.stringMatching(/^[0-9a-f]+$/i),
      artifact: 'PrivateCounter',
      deploymentsFile: HEAD_PATH,
      dryRun: false,
      // `[networks.local]` configures no explorer.
      explorerUrl: '',
      // INV-20: one circuit fits one transaction, so nothing is fragmented.
      fragments: 1,
      circuits: 1,
    });
    expect(result.blockHeight).toBeGreaterThan(0);
  }, 240_000);

  it('should store the seeded private state under the configured id', async () => {
    await expect(
      privateStateProvider.get(PRIVATE_STATE_ID),
    ).resolves.toStrictEqual(SEEDED_PRIVATE_STATE);
  });

  it('should persist a confirmed PrivateCounter record and nothing else', async () => {
    const head = JSON.parse(await readFile(HEAD_PATH, 'utf8'));

    expect(head).toStrictEqual({
      PrivateCounter: {
        status: 'confirmed',
        address: result.address,
        txId: result.txId,
        txHash: result.txHash,
        blockHeight: result.blockHeight,
        deployer: result.deployer,
        artifact: 'PrivateCounter',
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
  });
});
