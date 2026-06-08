import { existsSync } from 'node:fs';
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
 * Spec: `Deployments.record` rotates the head into history per
 * **(contract, network)** pair. Deploying a different contract on the
 * same network must not touch the first contract's history.
 *
 * Counter and SecondaryCounter share the same compiled artifact but
 * register under distinct names in `compact.toml`, so they have
 * independent head/history slots in `local.json` / `local.history.json`.
 */
describe('compact-deploy — history rotates per contract, not per network', () => {
  let firstCounterAddress: string;
  let secondaryAddress: string;
  let secondCounterAddress: string;

  beforeAll(async () => {
    requireFixtureArtifact();
    wipeDeployments();

    firstCounterAddress = (await deployFixture('Counter', 'ALICE')).address;
    secondaryAddress = (await deployFixture('SecondaryCounter', 'ALICE'))
      .address;
    secondCounterAddress = (await deployFixture('Counter', 'ALICE')).address;
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should produce distinct addresses for each deploy', () => {
    const seen = new Set([
      firstCounterAddress,
      secondaryAddress,
      secondCounterAddress,
    ]);
    expect(seen.size).toBe(3);
  });

  it('should keep both contracts at the head of local.json', async () => {
    const headPath = resolve(DEPLOYMENTS_DIR, 'local.json');
    expect(existsSync(headPath)).toBe(true);

    const head = JSON.parse(await readFile(headPath, 'utf8'));
    expect(head.Counter.address).toBe(secondCounterAddress);
    expect(head.SecondaryCounter.address).toBe(secondaryAddress);
  });

  it('should rotate only Counter into history, leaving SecondaryCounter untouched', async () => {
    const historyPath = resolve(DEPLOYMENTS_DIR, 'local.history.json');
    expect(existsSync(historyPath)).toBe(true);

    const history = JSON.parse(await readFile(historyPath, 'utf8'));
    expect(Array.isArray(history.Counter)).toBe(true);
    expect(history.Counter.length).toBe(1);
    expect(history.Counter[0].address).toBe(firstCounterAddress);

    expect(history.SecondaryCounter).toBeUndefined();
  });
});
