import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { PendingDeployExistsError } from './errors.ts';
import { readJson, writeJson } from './services/atomic-json.ts';
import { acquireLock, releaseLock } from './services/file-lock.ts';

/**
 * Two-file per-network deployment ledger:
 *   `<network>.json`         — head map (contract → latest deploy)
 *   `<network>.history.json` — superseded records (contract → list)
 * Each deploy rotates the prior head into history.
 */

/**
 * Fields known before the deploy tx is submitted. Never carries the
 * contract-maintenance signing key: midnight-js persists it via
 * `privateStateProvider.setSigningKey`, and this file is world-readable and
 * routinely committed.
 */
interface DeploymentRecordBase {
  address: string;
  txId: string;
  deployer: string;
  artifact: string;
}

/**
 * Submitted but not yet seen on chain. Written before the wait for
 * finalization so a dropped connection still leaves the address and txId on
 * disk.
 */
export interface PendingDeploymentRecord extends DeploymentRecordBase {
  status: 'pending';
  submittedAt: string;
}

/** Finalized on chain with a `SucceedEntirely` status. */
export interface ConfirmedDeploymentRecord extends DeploymentRecordBase {
  status: 'confirmed';
  txHash: string;
  blockHeight: number;
  timestamp: string;
}

/** A single deploy, in one of its two persisted states. */
export type DeploymentRecord =
  | PendingDeploymentRecord
  | ConfirmedDeploymentRecord;

/** Head map: contract name → latest deploy. */
export type DeploymentsFile = Record<string, DeploymentRecord>;

/** History map: contract name → past deploys (newest first). */
export type DeploymentsHistory = Record<string, DeploymentRecord[]>;

export interface DeploymentsOptions {
  rootDir: string;
  deploymentsDir: string;
  network: string;
}

/** Absolute on-disk paths for the two ledger files. */
export interface DeploymentsPaths {
  head: string;
  history: string;
}

export interface RecordOptions {
  /** Overwrite a pending head record instead of refusing. Argv: `--force`. */
  force?: boolean;
}

/**
 * Per-network deployment ledger. Head file is written last so a crash
 * mid-rotate leaves the prior head intact.
 */
export class Deployments {
  readonly #headPath: string;
  readonly #historyPath: string;

  constructor(opts: DeploymentsOptions) {
    const dir = isAbsolute(opts.deploymentsDir)
      ? opts.deploymentsDir
      : resolve(opts.rootDir, opts.deploymentsDir);
    this.#headPath = resolve(dir, `${opts.network}.json`);
    this.#historyPath = resolve(dir, `${opts.network}.history.json`);
  }

  get paths(): DeploymentsPaths {
    return { head: this.#headPath, history: this.#historyPath };
  }

  /**
   * Apply the pending-record rule without writing, so a blocked deploy fails
   * before a tx is proven and paid for rather than after.
   */
  async assertRecordable(
    contractName: string,
    opts: RecordOptions = {},
  ): Promise<void> {
    checkRecordable(await this.#readHead(), contractName, opts);
  }

  /**
   * Rotate the prior head for `contractName` into history; write `record` as
   * new head. Refuses when the prior head is still pending unless
   * `opts.force`, because overwriting it discards the only local trace of a
   * tx that may yet land.
   */
  async record(
    contractName: string,
    record: DeploymentRecord,
    opts: RecordOptions = {},
  ): Promise<DeploymentsPaths> {
    return this.#withLock(async () => {
      const head = await this.#readHead();
      checkRecordable(head, contractName, opts);
      const previous = head[contractName];
      if (previous) {
        const history = await this.#readHistory();
        const bucket = history[contractName] ?? [];
        bucket.unshift(previous);
        history[contractName] = bucket;
        await writeJson(this.#historyPath, history);
      }

      head[contractName] = record;
      await writeJson(this.#headPath, head);
    });
  }

  /**
   * Replace the head for `contractName` with its confirmed form. No history
   * rotation: the record it replaces is the pending half of the same deploy.
   */
  async confirm(
    contractName: string,
    record: ConfirmedDeploymentRecord,
  ): Promise<DeploymentsPaths> {
    return this.#withLock(async () => {
      const head = await this.#readHead();
      head[contractName] = record;
      await writeJson(this.#headPath, head);
    });
  }

  /** Latest deploy for `contractName`, or `undefined` if none. */
  async getHead(contractName: string): Promise<DeploymentRecord | undefined> {
    return (await this.#readHead())[contractName];
  }

  /** Per-contract history (newest first); empty array if none. */
  async getHistory(contractName: string): Promise<DeploymentRecord[]> {
    return (await this.#readHistory())[contractName] ?? [];
  }

  /** Names of every contract with a current head record on this network. */
  async listContracts(): Promise<string[]> {
    return Object.keys(await this.#readHead()).sort();
  }

  /**
   * Run `body` under `<network>.json.lock`. Every mutation is a
   * read-modify-write of two shared files, so concurrent deploys would
   * otherwise drop each other's records.
   */
  async #withLock(body: () => Promise<void>): Promise<DeploymentsPaths> {
    await mkdir(dirname(this.#headPath), { recursive: true });
    const lockPath = `${this.#headPath}.lock`;
    await acquireLock(lockPath);
    try {
      await body();
    } finally {
      await releaseLock(lockPath);
    }
    return { head: this.#headPath, history: this.#historyPath };
  }

  #readHead(): Promise<DeploymentsFile> {
    return readJson<DeploymentsFile>(this.#headPath, {});
  }

  #readHistory(): Promise<DeploymentsHistory> {
    return readJson<DeploymentsHistory>(this.#historyPath, {});
  }
}

function checkRecordable(
  head: DeploymentsFile,
  contractName: string,
  opts: RecordOptions,
): void {
  const previous = head[contractName];
  if (previous?.status === 'pending' && opts.force !== true) {
    throw new PendingDeployExistsError(contractName, previous.txId);
  }
}
