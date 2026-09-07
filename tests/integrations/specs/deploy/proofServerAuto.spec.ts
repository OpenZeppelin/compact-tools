import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFixture } from '../../_harness/deployer.ts';
import { runningAutoProofServers } from '../../_harness/docker.ts';
import { requireArtifact, wipeDeployments } from '../../_harness/paths.ts';

/**
 * `proof_server = "auto"` (or CLI `--proof-server auto`) boots a
 * `DynamicProofServerContainer` for the duration of the deploy and disposes
 * it on `Deployer[Symbol.asyncDispose]`. The container comes from the
 * `proof-server.yml` packaged in `@openzeppelin/compact-deployer`.
 *
 * Requires Docker.
 */
describe('compact-deploy — proof_server = "auto" boots and disposes a container', () => {
  beforeAll(() => {
    requireArtifact('Counter');
    wipeDeployments();
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should deploy through a container it boots and then stops', async () => {
    const result = await deployFixture('Counter', 'CHARLIE', {
      proofServer: 'auto',
    });

    expect(result.dryRun).toBe(false);
    expect(result.address).toMatch(/^[0-9a-f]+$/i);
    expect(result.txHash).toMatch(/^[0-9a-f]+$/i);
    expect(result.blockHeight).toBeGreaterThan(0);
    expect(runningAutoProofServers()).toStrictEqual([]);
  }, 240_000);

  it('should boot a fresh container for a second "auto" deploy', async () => {
    const result = await deployFixture('Counter', 'CHARLIE', {
      proofServer: 'auto',
    });

    expect(result.address).toMatch(/^[0-9a-f]+$/i);
    expect(runningAutoProofServers()).toStrictEqual([]);
  }, 240_000);
});
