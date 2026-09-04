import { rename, stat, unlink, writeFile } from 'node:fs/promises';
import { DeployError } from '../errors.ts';

/** A lock older than this is treated as abandoned by a crashed process. */
export const LOCK_STALE_MS = 30_000;
export const LOCK_RETRY_MS = 25;
export const LOCK_MAX_WAIT_MS = 10_000;

/** Timing overrides. Production callers take the defaults; tests shrink them. */
export interface LockOptions {
  staleMs?: number;
  retryMs?: number;
  maxWaitMs?: number;
}

/**
 * Take `lockPath` exclusively via `open(O_CREAT|O_EXCL)`. Retries on EEXIST;
 * removes the lock and retries once the holder's mtime passes
 * {@link LOCK_STALE_MS} so a killed deploy can't wedge the ledger
 * permanently. Throws {@link DeployError} past `maxWaitMs`.
 */
export async function acquireLock(
  lockPath: string,
  opts: LockOptions = {},
): Promise<void> {
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const retryMs = opts.retryMs ?? LOCK_RETRY_MS;
  const maxWaitMs = opts.maxWaitMs ?? LOCK_MAX_WAIT_MS;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx' });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (await breakIfStale(lockPath, staleMs)) continue;
      if (Date.now() > deadline) {
        throw new DeployError(
          `Timed out waiting for the deployments lock at ${lockPath}. Remove it if no deploy is running.`,
        );
      }
      await delay(retryMs);
    }
  }
}

/**
 * Remove `lockPath` if its mtime is older than `staleMs`. Reports whether it
 * did. The removal renames the lock aside before unlinking it: `rename` is
 * atomic, so of several waiters that all saw the same stale lock exactly one
 * takes it away and the losers go back to waiting.
 */
async function breakIfStale(
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  const staleBefore = Date.now() - staleMs;
  const parked = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    if ((await stat(lockPath)).mtimeMs > staleBefore) return false;
    await rename(lockPath, parked);
    // The stat above and this rename are not one instant: a waiter that won
    // the break may already have taken the lock, in which case the file just
    // parked is that waiter's fresh one. Put it back rather than acquire
    // alongside the holder.
    if ((await stat(parked)).mtimeMs > staleBefore) {
      await rename(parked, lockPath);
      return false;
    }
    await unlink(parked);
    return true;
  } catch (e) {
    // ENOENT: the holder released, or another waiter broke the lock first,
    // between our EEXIST and this call. Either way the next acquire wins the
    // race. Any other fault is not contention, and retrying it would surface
    // as a misleading lock timeout.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return false;
  }
}

/**
 * Release `lockPath`. Never throws: it runs in the caller's `finally`, where
 * throwing would mask a failing deploy's real error and turn a successful one
 * into a false failure.
 */
export async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (e) {
    // Already gone (stale-broken by another waiter). Nothing to release.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    // Anything else leaves the lock on disk, blocking other deploys until it
    // ages past `staleMs`. Warn on stderr to keep `--json` stdout parseable.
    process.emitWarning(
      `Could not release the deployments lock at ${lockPath}: ${(e as Error).message}`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
