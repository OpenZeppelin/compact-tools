import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Deployments, type DeploymentRecord } from './deployments.ts';

function rec(address: string): DeploymentRecord {
  return {
    address,
    txHash: '0xhash',
    txId: '0xtx',
    blockHeight: 42,
    signingKey: 'aa'.repeat(32),
    deployer: '0xdep',
    artifact: 'src/artifacts/Token/Token',
    timestamp: new Date('2026-05-15T00:00:00Z').toISOString(),
  };
}

function make(root: string): Deployments {
  return new Deployments({
    rootDir: root,
    deploymentsDir: 'deployments/compact',
    network: 'local',
  });
}

describe('Deployments', () => {
  it('should write a fresh deployments/<network>.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
    const { head } = await make(root).record('Token', rec('0xaddr1'));
    const parsed = JSON.parse(readFileSync(head, 'utf8'));
    expect(parsed.Token.address).toBe('0xaddr1');
  });

  it('should rotate the previous head into history on overwrite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
    const d = make(root);
    await d.record('Token', rec('0xfirst'));
    const { head, history } = await d.record('Token', rec('0xsecond'));

    const headJson = JSON.parse(readFileSync(head, 'utf8'));
    const historyJson = JSON.parse(readFileSync(history, 'utf8'));

    expect(headJson.Token.address).toBe('0xsecond');
    expect(historyJson.Token).toHaveLength(1);
    expect(historyJson.Token[0].address).toBe('0xfirst');
  });

  it('should preserve other contracts when one is updated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
    const d = make(root);
    await d.record('Token', rec('0xT1'));
    const { head } = await d.record('Vault', rec('0xV1'));
    const headJson = JSON.parse(readFileSync(head, 'utf8'));
    expect(headJson.Token.address).toBe('0xT1');
    expect(headJson.Vault.address).toBe('0xV1');
  });

  it('should let getHead/getHistory/listContracts read what record wrote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
    const d = make(root);
    await d.record('Token', rec('0xT1'));
    await d.record('Token', rec('0xT2'));
    await d.record('Vault', rec('0xV1'));

    expect((await d.getHead('Token'))?.address).toBe('0xT2');
    expect(await d.getHead('Missing')).toBeUndefined();
    expect((await d.getHistory('Token')).map((r) => r.address)).toEqual(['0xT1']);
    expect(await d.getHistory('Vault')).toEqual([]);
    expect(await d.listContracts()).toEqual(['Token', 'Vault']);
  });
});
