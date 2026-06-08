import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFixture } from '../../_harness/deployer.ts';
import { requireArtifact, wipeDeployments } from '../../_harness/paths.ts';

/**
 * Spec: `proof_server = "auto"` (or CLI `--proof-server auto`) boots a
 * `DynamicProofServerContainer` for the duration of the deploy and
 * disposes it on `Deployer[Symbol.asyncDispose]`.
 *
 * The deploy succeeding end-to-end is sufficient proof: prepare boots
 * the container, the deploy submits through it, then `await using`
 * stops it. A leaked container would surface in a later run as a
 * port collision.
 *
 * TODO: un-skip once the `auto` path has a compose file to boot from.
 * `DynamicProofServerContainer.start` builds a `DockerComposeEnvironment`
 * over `<cwd>/proof-server.yml`, which this repo does not ship, so every
 * `auto` deploy fails with `open <cwd>/proof-server.yml: no such file or
 * directory`.
 */
describe.skip('compact-deploy — proof_server = "auto" boots and disposes a container', () => {
  beforeAll(() => {
    requireArtifact('Counter');
    wipeDeployments();
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should boot a dynamic proof-server container and deploy successfully', async () => {
    const result = await deployFixture('Counter', 'CHARLIE', {
      proofServer: 'auto',
    });

    expect(result.dryRun).toBe(false);
    expect(result.address).toMatch(/^[0-9a-f]+$/i);
    expect(result.txHash).toMatch(/^[0-9a-f]+$/i);
    expect(result.blockHeight).toBeGreaterThan(0);
  }, 240_000);

  it('should leave no zombie container — a subsequent "auto" deploy still works', async () => {
    const result = await deployFixture('Counter', 'CHARLIE', {
      proofServer: 'auto',
    });
    expect(result.address).toMatch(/^[0-9a-f]+$/i);
  }, 240_000);
});
