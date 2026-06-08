import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deployFixture } from '../../_harness/deployer.ts';
import {
  requireFixtureArtifact,
  wipeDeployments,
} from '../../_harness/paths.ts';

/**
 * Spec: `proof_server = "auto"` (or CLI `--proof-server auto`) boots a
 * `DynamicProofServerContainer` for the duration of the deploy and
 * disposes it on `Deployer[Symbol.asyncDispose]`.
 *
 * The deploy succeeding end-to-end is sufficient proof: prepare boots
 * the container, the deploy submits through it, then `await using`
 * stops it. A leaked container would surface in a later run as a
 * health-check failure or port collision.
 *
 * SKIPPED — upstream `testkit-js` issue:
 *   `DynamicProofServerContainer.start` waits for a log line matching
 *   the regex `.*Started.*` that the current
 *   `midnightntwrk/proof-server:latest` image no longer emits. The
 *   container exits without ever producing that marker, so
 *   `testcontainers` throws "Log stream ended and message was not
 *   received". Re-enable once `testkit-js`'s wait strategy is updated
 *   (or once we override it locally).
 */
describe.skip('compact-deploy — proof_server = "auto" boots and disposes a container', () => {
  beforeAll(() => {
    requireFixtureArtifact();
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
