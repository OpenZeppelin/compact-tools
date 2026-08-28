import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

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

/** A lock older than this is treated as abandoned by a crashed process. */
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 25;
const LOCK_MAX_WAIT_MS = 10_000;

/**
 * Take `lockPath` exclusively via `open(O_CREAT|O_EXCL)`. Retries on EEXIST;
 * unlinks and retries once the holder's mtime passes {@link LOCK_STALE_MS}
 * so a killed deploy can't wedge the ledger permanently.
 */
async function acquireLock(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (await breakIfStale(lockPath)) continue;
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for the deployments lock at ${lockPath}. Remove it if no deploy is running.`,
        );
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

/** Unlink `lockPath` if its mtime is older than {@link LOCK_STALE_MS}. Reports whether it did. */
async function breakIfStale(lockPath: string): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(lockPath);
    if (Date.now() - mtimeMs < LOCK_STALE_MS) return false;
    await unlink(lockPath);
    return true;
  } catch {
    // Holder released between our EEXIST and the stat/unlink; the next
    // acquire attempt will win the race normally.
    return false;
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // Already gone (stale-broken by another waiter). Nothing to release.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  const raw = await readFile(path, 'utf8');
  if (!raw.trim()) return fallback;
  return JSON.parse(raw) as T;
}

// Write atomically: a crash mid-write would otherwise leave a truncated
// `*.json`, breaking subsequent reads and losing durable deploy state.
// Write to a sibling temp file, then rename it into place (atomic on the
// same filesystem).
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}
