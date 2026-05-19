import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFixture } from '../../_harness/deployer.ts';
import {
  DEPLOYMENTS_DIR,
  requireFixtureArtifact,
  wipeDeployments,
} from '../../_harness/paths.ts';

/**
 * Spec: a fresh `compact-deploy` invocation puts Counter on the local
 * chain and writes a complete deployment record. Exercises the full
 * pipeline end-to-end against the live Midnight stack.
 */
describe('compact-deploy — Counter deploys to local stack', () => {
  beforeAll(() => {
    requireFixtureArtifact();
    wipeDeployments();
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should return an address, txHash, signingKey, and block height', async () => {
    const result = await deployFixture('Counter', 'DEPLOYER');

    expect(result.dryRun).toBe(false);
    expect(result.contractName).toBe('Counter');
    expect(result.network).toBe('local');
    expect(result.address).toMatch(/^[0-9a-f]+$/i);
    expect(result.txId).toMatch(/^[0-9a-f]+$/i);
    expect(result.txHash).toMatch(/^[0-9a-f]+$/i);
    expect(result.blockHeight).toBeGreaterThan(0);
    expect(result.signingKey).toMatch(/^[0-9a-f]{64}$/);
    expect(result.deployer).toBeTruthy();
  });

  it('should persist the deployment record at deployments/compact/local.json', async () => {
    const headPath = resolve(DEPLOYMENTS_DIR, 'local.json');
    expect(existsSync(headPath)).toBe(true);

    const head = JSON.parse(await readFile(headPath, 'utf8'));
    expect(head.Counter).toBeDefined();
    expect(head.Counter.address).toMatch(/^[0-9a-f]+$/i);
    expect(head.Counter.txHash).toMatch(/^[0-9a-f]+$/i);
    expect(head.Counter.signingKey).toMatch(/^[0-9a-f]{64}$/);
    expect(head.Counter.deployer).toBeTruthy();
    expect(head.Counter.artifact).toBe('Counter');
    expect(head.Counter.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
