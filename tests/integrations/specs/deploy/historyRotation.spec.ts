import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFixture } from '../../_harness/deployer.ts';
import {
  DEPLOYMENTS_DIR,
  requireFixtureArtifact,
  wipeDeployments,
} from '../../_harness/paths.ts';

/**
 * Spec: redeploying the same contract rotates the previous head into
 * `<network>.history.json`. Verifies the persist module's append-to-history
 * behaviour against real deploy results.
 */
describe('compact-deploy — redeploy rotates head into history', () => {
  let firstAddress: string;
  let secondAddress: string;

  beforeAll(async () => {
    requireFixtureArtifact();
    wipeDeployments();
    firstAddress = (await deployFixture('Counter', 'BOB')).address;
    secondAddress = (await deployFixture('Counter', 'BOB')).address;
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should produce distinct addresses on each deploy', () => {
    expect(firstAddress).not.toBe(secondAddress);
    expect(firstAddress).toMatch(/^[0-9a-f]+$/i);
    expect(secondAddress).toMatch(/^[0-9a-f]+$/i);
  });

  it('should keep the latest deployment at the head', async () => {
    const head = JSON.parse(
      await readFile(resolve(DEPLOYMENTS_DIR, 'local.json'), 'utf8'),
    );
    expect(head.Counter.address).toBe(secondAddress);
  });

  it('should move the previous head into <network>.history.json', async () => {
    const history = JSON.parse(
      await readFile(
        resolve(DEPLOYMENTS_DIR, 'local.history.json'),
        'utf8',
      ),
    );
    expect(Array.isArray(history.Counter)).toBe(true);
    expect(history.Counter.length).toBeGreaterThanOrEqual(1);
    expect(history.Counter[0].address).toBe(firstAddress);
  });
});
