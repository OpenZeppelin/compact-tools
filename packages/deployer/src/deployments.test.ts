import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ConfirmedDeploymentRecord,
  Deployments,
  type PendingDeploymentRecord,
} from './deployments.ts';
import { PendingDeployExistsError } from './errors.ts';

/** Never persisted; the pinning test asserts the ledger file omits it. */
const SIGNING_KEY_HEX = 'aa'.repeat(32);

function confirmed(address: string): ConfirmedDeploymentRecord {
  return {
    status: 'confirmed',
    address,
    txHash: '0xhash',
    txId: '0xtx',
    blockHeight: 42,
    deployer: '0xdep',
    artifact: 'src/artifacts/Token/Token',
    timestamp: new Date('2026-05-15T00:00:00Z').toISOString(),
  };
}

function pending(
  address: string,
  txId = '0xpendingtx',
): PendingDeploymentRecord {
  return {
    status: 'pending',
    address,
    txId,
    deployer: '0xdep',
    artifact: 'src/artifacts/Token/Token',
    submittedAt: new Date('2026-05-15T00:00:00Z').toISOString(),
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
    const { head } = await make(root).record('Token', confirmed('0xaddr1'));
    const parsed = JSON.parse(readFileSync(head, 'utf8'));
    expect(parsed.Token.address).toBe('0xaddr1');
    expect(parsed.Token.status).toBe('confirmed');
  });

  it('should rotate the previous head into history on overwrite', async () => {
    const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
    const d = make(root);
    await d.record('Token', confirmed('0xfirst'));
    const { head, history } = await d.record('Token', confirmed('0xsecond'));

    const headJson = JSON.parse(readFileSync(head, 'utf8'));
    const historyJson = JSON.parse(readFileSync(history, 'utf8'));

    expect(headJson.Token.address).toBe('0xsecond');
    expect(historyJson.Token).toHaveLength(1);
    expect(historyJson.Token[0].address).toBe('0xfirst');
  });

  it('should preserve other contracts when one is updated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
    const d = make(root);
    await d.record('Token', confirmed('0xT1'));
    const { head } = await d.record('Vault', confirmed('0xV1'));
    const headJson = JSON.parse(readFileSync(head, 'utf8'));
    expect(headJson.Token.address).toBe('0xT1');
    expect(headJson.Vault.address).toBe('0xV1');
  });

  it('should never persist a signing key, in the head or in history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
    const d = make(root);
    await d.record('Token', confirmed('0xT1'));
    const { head, history } = await d.record('Token', confirmed('0xT2'));

    for (const raw of [
      readFileSync(head, 'utf8'),
      readFileSync(history, 'utf8'),
    ]) {
      expect(raw).not.toContain(SIGNING_KEY_HEX);
      expect(raw).not.toContain('signingKey');
    }
  });

  it('should keep both records when two contracts are written concurrently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
    const d = make(root);
    // Same head file, interleaved read-modify-write: without the lock the
    // later write clobbers the earlier contract's record.
    const [{ head }] = await Promise.all([
      d.record('Token', confirmed('0xT1')),
      d.record('Vault', confirmed('0xV1')),
    ]);

    const headJson = JSON.parse(readFileSync(head, 'utf8'));
    expect(headJson.Token.address).toBe('0xT1');
    expect(headJson.Vault.address).toBe('0xV1');
  });

  it('should honour an absolute deploymentsDir and expose paths', async () => {
    const absDir = mkdtempSync(join(tmpdir(), 'persist-abs-'));
    const d = new Deployments({
      rootDir: '/unused/root',
      deploymentsDir: absDir,
      network: 'local',
    });
    expect(d.paths.head).toBe(join(absDir, 'local.json'));
    expect(d.paths.history).toBe(join(absDir, 'local.history.json'));
  });

  it('should let getHead/getHistory/listContracts read what record wrote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
    const d = make(root);
    await d.record('Token', confirmed('0xT1'));
    await d.record('Token', confirmed('0xT2'));
    await d.record('Vault', confirmed('0xV1'));

    expect((await d.getHead('Token'))?.address).toBe('0xT2');
    expect(await d.getHead('Missing')).toBeUndefined();
    expect((await d.getHistory('Token')).map((r) => r.address)).toEqual([
      '0xT1',
    ]);
    expect(await d.getHistory('Vault')).toEqual([]);
    expect(await d.listContracts()).toEqual(['Token', 'Vault']);
  });

  describe('pending records', () => {
    it('should persist a pending record with its submittedAt stamp', async () => {
      const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
      const { head } = await make(root).record('Token', pending('0xaddr1'));
      const parsed = JSON.parse(readFileSync(head, 'utf8'));
      expect(parsed.Token).toStrictEqual({
        status: 'pending',
        address: '0xaddr1',
        txId: '0xpendingtx',
        deployer: '0xdep',
        artifact: 'src/artifacts/Token/Token',
        submittedAt: '2026-05-15T00:00:00.000Z',
      });
    });

    it('should refuse to record over a pending head', async () => {
      const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
      const d = make(root);
      await d.record('Token', pending('0xfirst', '0xSTUCK'));

      const thrown = await d
        .record('Token', pending('0xsecond'))
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(PendingDeployExistsError);
      expect((thrown as Error).message).toContain('0xSTUCK');

      const headJson = JSON.parse(readFileSync(d.paths.head, 'utf8'));
      expect(headJson.Token.address).toBe('0xfirst');
    });

    it('should replace a pending head under force, rotating it into history', async () => {
      const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
      const d = make(root);
      await d.record('Token', pending('0xfirst'));
      const { head, history } = await d.record('Token', pending('0xsecond'), {
        force: true,
      });

      expect(JSON.parse(readFileSync(head, 'utf8')).Token.address).toBe(
        '0xsecond',
      );
      expect(JSON.parse(readFileSync(history, 'utf8')).Token[0].address).toBe(
        '0xfirst',
      );
    });

    it('should reject assertRecordable while a pending head stands, and pass under force', async () => {
      const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
      const d = make(root);
      await d.record('Token', pending('0xfirst', '0xSTUCK'));

      await expect(d.assertRecordable('Token')).rejects.toThrow(/0xSTUCK/);
      await expect(
        d.assertRecordable('Token', { force: true }),
      ).resolves.toBeUndefined();
      await expect(d.assertRecordable('Vault')).resolves.toBeUndefined();
    });

    it('should promote a pending head to confirmed without touching history', async () => {
      const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
      const d = make(root);
      await d.record('Token', pending('0xaddr1'));
      const { head } = await d.confirm('Token', confirmed('0xaddr1'));

      expect(JSON.parse(readFileSync(head, 'utf8')).Token.status).toBe(
        'confirmed',
      );
      expect(await d.getHistory('Token')).toEqual([]);
    });

    it('should let a confirmed head be re-recorded without force', async () => {
      const root = mkdtempSync(join(tmpdir(), 'persist-test-'));
      const d = make(root);
      await d.record('Token', pending('0xaddr1'));
      await d.confirm('Token', confirmed('0xaddr1'));

      const { head } = await d.record('Token', pending('0xaddr2'));
      expect(JSON.parse(readFileSync(head, 'utf8')).Token.address).toBe(
        '0xaddr2',
      );
    });
  });
});
