import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFixture } from '../_harness/deployer.ts';
import {
  DEPLOYMENTS_DIR,
  requireFixtureArtifact,
  wipeDeployments,
} from '../_harness/paths.ts';

/**
 * Spec: `--dry-run` performs every validation step (config, artifact,
 * wallet seed, providers) without submitting a transaction. No
 * deployments file should be written.
 */
describe('compact-deploy — --dry-run validates without submitting', () => {
  beforeAll(() => {
    requireFixtureArtifact();
    wipeDeployments();
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should return dryRun=true and an empty address', async () => {
    const result = await deployFixture('Counter', 'ALICE', { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.address).toBe('');
    expect(result.contractName).toBe('Counter');
    expect(result.network).toBe('local');
    expect(result.signingKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('should not write a deployments file', () => {
    expect(existsSync(resolve(DEPLOYMENTS_DIR, 'local.json'))).toBe(false);
    expect(existsSync(resolve(DEPLOYMENTS_DIR, 'local.history.json'))).toBe(
      false,
    );
  });
});
