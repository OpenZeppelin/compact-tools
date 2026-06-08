import { readFile } from 'node:fs/promises';
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
 * Spec: a fresh `compact-deploy` invocation puts Counter on the local
 * chain and writes a complete deployment record. Exercises the full
 * pipeline end-to-end against the live Midnight stack.
 */
describe('compact-deploy — Counter deploys to local stack', () => {
  const HEAD_PATH = resolve(DEPLOYMENTS_DIR, 'local.json');
  let result: DeployResult;

  beforeAll(async () => {
    requireArtifact('Counter');
    wipeDeployments();
    result = await deployFixture('Counter', 'DEPLOYER');
  });

  afterAll(() => {
    wipeDeployments();
  });

  it('should return every on-chain identifier for the finalized tx', () => {
    expect(result).toStrictEqual({
      contractName: 'Counter',
      network: 'local',
      address: expect.stringMatching(/^[0-9a-f]+$/i),
      txId: expect.stringMatching(/^[0-9a-f]+$/i),
      txHash: expect.stringMatching(/^[0-9a-f]+$/i),
      blockHeight: expect.any(Number),
      deployer: expect.stringMatching(/^[0-9a-f]+$/i),
      artifact: 'Counter',
      deploymentsFile: HEAD_PATH,
      dryRun: false,
      // `[networks.local]` configures no explorer.
      explorerUrl: '',
    });
    expect(result.blockHeight).toBeGreaterThan(0);
  });

  it('should persist a confirmed record and nothing else', async () => {
    const head = JSON.parse(await readFile(HEAD_PATH, 'utf8'));

    // Exact shape, not field probes: the record must never regrow a
    // `signingKey` field — the ledger is world-readable and committed.
    expect(head).toStrictEqual({
      Counter: {
        status: 'confirmed',
        address: result.address,
        txId: result.txId,
        txHash: result.txHash,
        blockHeight: result.blockHeight,
        deployer: result.deployer,
        artifact: 'Counter',
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
  });
});
