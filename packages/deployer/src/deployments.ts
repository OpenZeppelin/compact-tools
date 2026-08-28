import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { readJson, writeJson } from './services/atomic-json.ts';
import { acquireLock, releaseLock } from './services/file-lock.ts';

/**
 * Two-file per-network deployment ledger:
 *   `<network>.json`         — head map (contract → latest deploy)
 *   `<network>.history.json` — superseded records (contract → list)
 * Each deploy rotates the prior head into history.
 */

/**
 * A single confirmed deploy. Persisted under the contract name in the head
 * map. Never carries the contract-maintenance signing key: midnight-js
 * already persists it via `privateStateProvider.setSigningKey`, and this
 * file is world-readable and routinely committed.
 */
export interface DeploymentRecord {
  address: string;
  txHash: string;
  txId: string;
  blockHeight: number;
  deployer: string;
  artifact: string;
  timestamp: string;
}

/** Head map: contract name → latest deploy. */
export type DeploymentsFile = Record<string, DeploymentRecord>;

/** History map: contract name → past deploys (newest first). */
export type DeploymentsHistory = Record<string, DeploymentRecord[]>;

export interface DeploymentsOptions {
  rootDir: string;
  deploymentsDir: string;
  network: string;
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

  /** Absolute on-disk paths for the two ledger files. */
  get paths(): { head: string; history: string } {
    return { head: this.#headPath, history: this.#historyPath };
  }

  /**
   * Rotate the prior head for `contractName` into history; write `record` as
   * new head. Serialised across processes by `<network>.json.lock`: the whole
   * body is a read-modify-write of two shared files, so concurrent deploys
   * would otherwise drop each other's records.
   */
  async record(
    contractName: string,
    record: DeploymentRecord,
  ): Promise<{ head: string; history: string }> {
    await mkdir(dirname(this.#headPath), { recursive: true });

    const lockPath = `${this.#headPath}.lock`;
    await acquireLock(lockPath);
    try {
      const head = await this.#readHead();
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
    } finally {
      await releaseLock(lockPath);
    }

    return { head: this.#headPath, history: this.#historyPath };
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

  #readHead(): Promise<DeploymentsFile> {
    return readJson<DeploymentsFile>(this.#headPath, {});
  }

  #readHistory(): Promise<DeploymentsHistory> {
    return readJson<DeploymentsHistory>(this.#historyPath, {});
  }
}
