import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DeployResult } from '@openzeppelin/compact-deployer/deployer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFixture } from '../../_harness/deployer.ts';
import {
  DEPLOYMENTS_DIR,
  requireArtifact,
  wipeDeployments,
} from '../../_harness/paths.ts';

/**
 * Spec: `--dry-run` performs every validation step (config, artifact,
 * wallet seed, providers) without submitting a transaction. No
 * deployments file should be written.
 */
describe('compact-deploy — --dry-run validates without submitting', () => {
  let result: DeployResult;

  beforeAll(async () => {
    requireArtifact('Counter');
    wipeDeployments();
    result = await deployFixture('Counter', 'ALICE', { dryRun: true });
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should return dryRun=true with every on-chain field empty', () => {
    expect(result).toStrictEqual({
      contractName: 'Counter',
      network: 'local',
      address: '',
      txId: '',
      txHash: '',
      blockHeight: 0,
      deployer: expect.stringMatching(/^[0-9a-f]+$/i),
      artifact: 'Counter',
      deploymentsFile: '',
      dryRun: true,
      explorerUrl: '',
      // A dry run submits nothing, so it reports the artifact's circuit count
      // against no transactions.
      fragments: 0,
      circuits: 1,
    });
  });

  it('should not write a deployments file', () => {
    expect(existsSync(resolve(DEPLOYMENTS_DIR, 'local.json'))).toBe(false);
    expect(existsSync(resolve(DEPLOYMENTS_DIR, 'local.history.json'))).toBe(
      false,
    );
  });
});
