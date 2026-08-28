import {
  chmodSync,
  existsSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, LOCK_STALE_MS, releaseLock } from './file-lock.ts';

/**
 * Injects an `unlink` failure without touching directory permissions, so the
 * EACCES paths are exercised even for a uid that chmod cannot constrain.
 * Pass-through while `code` is unset.
 */
const unlinkFault = vi.hoisted(() => ({
  code: undefined as string | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: (path: Parameters<typeof actual.unlink>[0]) => {
      if (unlinkFault.code === undefined) return actual.unlink(path);
      const err: NodeJS.ErrnoException = new Error(
        `EACCES: permission denied, unlink '${String(path)}'`,
      );
      err.code = unlinkFault.code;
      return Promise.reject(err);
    },
  };
});

afterEach(() => {
  unlinkFault.code = undefined;
});

function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'file-lock-test-')), 'head.json.lock');
}

/** A held lock in a read-only directory: `stat` resolves, `unlink` fails EACCES. */
function unremovableLock(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'file-lock-test-'));
  const path = join(dir, 'head.json.lock');
  writeFileSync(path, '999999\n');
  return { dir, path };
}

// chmod does not constrain root, so the permission-fault cases cannot run there.
const isRoot = process.getuid?.() === 0;

describe('acquireLock', () => {
  it('should create the lock file and remove it on release', async () => {
    const path = lockPath();
    await acquireLock(path);
    expect(existsSync(path)).toBe(true);
    await releaseLock(path);
    expect(existsSync(path)).toBe(false);
  });

  it('should block a contending acquire until the holder releases', async () => {
    const path = lockPath();
    await acquireLock(path, { retryMs: 1 });
    let acquired = false;
    const contender = acquireLock(path, { retryMs: 1 }).then(() => {
      acquired = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(acquired).toBe(false);
    await releaseLock(path);
    await contender;
    expect(acquired).toBe(true);
    await releaseLock(path);
  });

  it('should break a lock whose mtime is older than the stale window', async () => {
    const path = lockPath();
    writeFileSync(path, '999999\n');
    // Age the holder past the stale window so the next acquire unlinks it
    // instead of waiting out the (much longer) timeout.
    const aged = (Date.now() - LOCK_STALE_MS * 2) / 1000;
    utimesSync(path, aged, aged);
    await acquireLock(path, { retryMs: 1, maxWaitMs: 200 });
    expect(existsSync(path)).toBe(true);
    await releaseLock(path);
  });

  it('should throw a removal hint when a fresh lock outlives maxWaitMs', async () => {
    const path = lockPath();
    writeFileSync(path, '999999\n');
    await expect(
      acquireLock(path, { retryMs: 1, maxWaitMs: 20 }),
    ).rejects.toThrow(/Timed out waiting for the deployments lock/);
  });

  it('should rethrow a non-EEXIST failure instead of retrying', async () => {
    // Parent directory does not exist: `open(O_CREAT|O_EXCL)` fails ENOENT,
    // which is not contention and must surface immediately.
    const path = join(lockPath(), 'nested', 'head.json.lock');
    await expect(acquireLock(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('should keep waiting when the lock vanishes before the stale check', async () => {
    // A dangling symlink reproduces the release-between-EEXIST-and-stat
    // race deterministically: `open(O_CREAT|O_EXCL)` still fails EEXIST,
    // while `stat` follows the link and fails ENOENT.
    const path = lockPath();
    symlinkSync(join(path, '..', 'gone'), path);
    await expect(
      acquireLock(path, { retryMs: 1, maxWaitMs: 30 }),
    ).rejects.toThrow(/Timed out waiting for the deployments lock/);
  });

  it('should surface a stale-break unlink fault regardless of uid', async () => {
    const { path } = unremovableLock();
    const aged = (Date.now() - LOCK_STALE_MS * 2) / 1000;
    utimesSync(path, aged, aged);
    unlinkFault.code = 'EACCES';
    await expect(
      acquireLock(path, { retryMs: 1, maxWaitMs: 50 }),
    ).rejects.toMatchObject({ code: 'EACCES' });
  });

  it.skipIf(isRoot)(
    'should surface a stale-break permission fault instead of timing out',
    async () => {
      const { dir, path } = unremovableLock();
      const aged = (Date.now() - LOCK_STALE_MS * 2) / 1000;
      utimesSync(path, aged, aged);
      chmodSync(dir, 0o500);
      try {
        await expect(
          acquireLock(path, { retryMs: 1, maxWaitMs: 50 }),
        ).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        chmodSync(dir, 0o700);
      }
    },
  );
});

describe('releaseLock', () => {
  it('should be a no-op when the lock file is already gone', async () => {
    const path = lockPath();
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    await expect(releaseLock(path)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('should warn rather than throw on an unlink fault regardless of uid', async () => {
    const { path } = unremovableLock();
    unlinkFault.code = 'EACCES';
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      await expect(releaseLock(path)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Could not release the deployments lock'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it.skipIf(isRoot)(
    'should warn rather than throw when the lock cannot be removed',
    async () => {
      const { dir, path } = unremovableLock();
      chmodSync(dir, 0o500);
      const warn = vi
        .spyOn(process, 'emitWarning')
        .mockImplementation(() => {});
      try {
        await expect(releaseLock(path)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('Could not release the deployments lock'),
        );
      } finally {
        warn.mockRestore();
        chmodSync(dir, 0o700);
      }
    },
  );
});
