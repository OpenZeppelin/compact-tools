import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  DeploymentsFileError,
  PartialDeployExistsError,
  PendingDeployExistsError,
} from './errors.ts';
import { readJson, writeJson } from './services/atomic-json.ts';
import { acquireLock, releaseLock } from './services/file-lock.ts';

/**
 * Two-file per-network deployment ledger:
 *   `<network>.json`         — head map (contract → latest deploy)
 *   `<network>.history.json` — superseded records (contract → list)
 * Each deploy rotates the prior head into history.
 */

/**
 * Fields known before the deploy tx is submitted. INV-22: never carries the
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

/**
 * A fragmented deploy whose deploy tx landed but whose verifier-key inserts are
 * unfinished. The contract exists and is callable with `circuitsOnChain`.
 *
 * Reporting only: a resume recomputes the remaining set from chain state, and
 * these two lists are never a logic input.
 */
export interface PartialDeploymentRecord extends DeploymentRecordBase {
  status: 'partial';
  /** Copied from the most recent chain read, not from the fragment plan. */
  circuitsOnChain: readonly string[];
  circuitsPending: readonly string[];
  submittedAt: string;
  /** Deploy-tx identifiers, carried into the confirmed record across a resume. */
  txHash?: string;
  blockHeight?: number;
  /**
   * An insert this deploy submitted but never saw land. It may land after the
   * run stops, so a resume settles it before reading the state it plans from.
   * Written only when the wait timed out; a transaction the node ruled on is
   * cleared instead.
   */
  pendingTxId?: string;
  /** Circuits {@link pendingTxId} carried, so a resume can wait for them. */
  pendingCircuits?: readonly string[];
}

/** Finalized on chain with a `SucceedEntirely` status. */
export interface ConfirmedDeploymentRecord extends DeploymentRecordBase {
  status: 'confirmed';
  txHash: string;
  blockHeight: number;
  timestamp: string;
}

/** INV-3: a single deploy, in one of its three persisted states. */
export type DeploymentRecord =
  | PendingDeploymentRecord
  | PartialDeploymentRecord
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
  /** Overwrite a pending or partial head record instead of refusing. Argv: `--force`. */
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
   * rotation: the record it replaces is the pending or partial half of the
   * same deploy, which the address check enforces.
   */
  async confirm(
    contractName: string,
    record: ConfirmedDeploymentRecord,
  ): Promise<DeploymentsPaths> {
    return this.#replaceHead(contractName, record);
  }

  /**
   * Overwrite the head with a refreshed `partial` record for the same address.
   * No history rotation: each write reports further progress on one deploy.
   */
  async updatePartial(
    contractName: string,
    record: PartialDeploymentRecord,
  ): Promise<DeploymentsPaths> {
    return this.#replaceHead(contractName, record);
  }

  /** Overwrite the head for the same deploy. No history rotation. */
  #replaceHead(
    contractName: string,
    record: DeploymentRecord,
  ): Promise<DeploymentsPaths> {
    return this.#withLock(async () => {
      const head = await this.#readHead();
      assertSameDeploy(head[contractName], record, contractName);
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
  if (previous === undefined || opts.force === true) return;
  if (previous.status === 'pending') {
    throw new PendingDeployExistsError(contractName, previous.txId);
  }
  if (previous.status === 'partial') {
    // INV-26: without --force a partial head resumes, and the caller takes
    // that branch before ever asking to record, so reaching here means it was
    // about to deploy a second address.
    throw new PartialDeployExistsError(contractName, previous.address);
  }
  // INV-3: a new union member fails to compile here until it is handled above.
  previous.status satisfies 'confirmed';
}

/**
 * INV-16: a promotion must land on the head it was derived from. Anything else means a
 * concurrent deploy replaced the head, and overwriting it would drop the only
 * local trace of that contract.
 */
function assertSameDeploy(
  previous: DeploymentRecord | undefined,
  record: DeploymentRecord,
  contractName: string,
): void {
  if (previous === undefined) {
    throw new DeploymentsFileError(
      `Cannot update "${contractName}": its head record disappeared. Record it by hand: address ${record.address}, txId ${record.txId}.`,
    );
  }
  if (previous.address !== record.address) {
    throw new DeploymentsFileError(
      `Cannot update "${contractName}": the head record is now ${previous.address}, not ${record.address}. Record it by hand: address ${record.address}, txId ${record.txId}.`,
    );
  }
  if (previous.status === 'confirmed') {
    throw new DeploymentsFileError(
      `Cannot update "${contractName}": its head record is already confirmed. Record it by hand: address ${record.address}, txId ${record.txId}.`,
    );
  }
}
