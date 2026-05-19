import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Two-file deployment ledger per network.
 *
 *   <deploymentsDir>/<network>.json          — latest record per contract (head map)
 *   <deploymentsDir>/<network>.history.json  — superseded records (per-contract history list)
 *
 * On every deploy the previous head is moved into the history list and the
 * new record becomes head. Consumers (CLIs, scripts) typically read just
 * the head file; the history list is for audit and rollback.
 */

/** A single confirmed deploy. Persisted under the contract name in the head map. */
export interface DeploymentRecord {
  address: string;
  txHash: string;
  txId: string;
  blockHeight: number;
  signingKey: string;
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
 * Read/write the per-network deployment ledger.
 *
 * One instance owns one `<network>` pair; create a fresh ledger for each
 * network you touch. Reads are cheap (one JSON load each), writes are
 * atomic (head rotation + new head in one logical operation, head file
 * written last so a crash mid-rotate leaves the previous head intact).
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
   * Rotate any prior head record for `contractName` into history, then write
   * `record` as the new head. Returns both absolute paths.
   */
  async record(
    contractName: string,
    record: DeploymentRecord,
  ): Promise<{ head: string; history: string }> {
    await mkdir(dirname(this.#headPath), { recursive: true });

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

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  const raw = await readFile(path, 'utf8');
  if (!raw.trim()) return fallback;
  return JSON.parse(raw) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
