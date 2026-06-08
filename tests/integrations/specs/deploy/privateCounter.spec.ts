import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { DeployResult } from '@openzeppelin/compact-deployer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFixture } from '../../_harness/deployer.ts';
import {
  DEPLOYMENTS_DIR,
  requirePrivateCounterArtifact,
  wipeDeployments,
} from '../../_harness/paths.ts';

/**
 * Spec: the `PrivateCounter` fixture exercises two deploy-pipeline
 * paths the minimal `Counter` doesn't:
 *
 *  1. **`init_private_state`** — the deployer's
 *     `executeDeploy` includes `privateStateId` + `initialPrivateState`
 *     in the contract-deploy options. The JSON file ships
 *     `{ delta: 7n }` (bigint-revived) as the seed.
 *
 *  2. **Witnesses-module resolution** — `compact.toml` references
 *     `witnesses = { module = "...PrivateCounter.witness.ts", export =
 *     "PrivateCounterWitnesses" }`. `Artifact.load` resolves the export
 *     via Node's dynamic `import()`, calls the factory, and threads the
 *     impls into the compiled contract.
 *
 * Both are implicit: a successful deploy means both code paths ran. We
 * also re-read the on-disk deployment record to lock in the persistence
 * contract for a private-state contract.
 *
 * Prereq: `make -C tests/integrations compile` must have produced the
 * `PrivateCounter` artifact directory.
 */
describe('compact-deploy — PrivateCounter exercises private-state + witnesses-module paths', () => {
  let result: DeployResult;

  beforeAll(async () => {
    requirePrivateCounterArtifact();
    wipeDeployments();
    result = await deployFixture('PrivateCounter', 'CHARLIE');
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should deploy successfully with init_private_state + witnesses-module configured', () => {
    expect(result.dryRun).toBe(false);
    expect(result.contractName).toBe('PrivateCounter');
    expect(result.network).toBe('local');
    expect(result.address).toMatch(/^[0-9a-f]+$/i);
    expect(result.txHash).toMatch(/^[0-9a-f]+$/i);
    expect(result.blockHeight).toBeGreaterThan(0);
    expect(result.signingKey).toMatch(/^[0-9a-f]{64}$/);
  }, 240_000);

  it('should record the deployment under PrivateCounter in local.json', async () => {
    const headPath = resolve(DEPLOYMENTS_DIR, 'local.json');
    expect(existsSync(headPath)).toBe(true);

    const head = JSON.parse(await readFile(headPath, 'utf8'));
    expect(head.PrivateCounter).toBeDefined();
    expect(head.PrivateCounter.address).toBe(result.address);
    expect(head.PrivateCounter.artifact).toBe('PrivateCounter');
  });
});
