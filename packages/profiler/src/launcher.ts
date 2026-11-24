import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hostOptions,
  type ReleasedBinary,
  resolveBinary,
} from '@openzeppelin/compact-launcher';

export const COMPACT_PROFILE: ReleasedBinary = {
  name: 'compact-profile',
  packageName: 'compact-profiler',
  bin: 'compact-profile',
  overrideEnv: 'COMPACT_PROFILE_BINARY',
  downloadBaseEnv: 'COMPACT_PROFILE_DOWNLOAD_BASE',
};

// One level up from src/ and from dist/ alike, so both entry points find the manifest.
export const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

export interface BinaryOptions {
  /** Executable to run; skips `COMPACT_PROFILE_BINARY` and the download. */
  binary?: string;
}

/**
 * Path to the `compact-profile` executable, resolved as the `compact-profile` bin does:
 * `COMPACT_PROFILE_BINARY`, else the release asset cached per user, downloaded and verified
 * on first use.
 */
export function resolveProfileBinary(
  options: BinaryOptions = {},
): Promise<string> {
  if (options.binary !== undefined) {
    return Promise.resolve(options.binary);
  }
  return resolveBinary(hostOptions(COMPACT_PROFILE, packageDir));
}

/** What one run of the binary printed and how it exited. */
export interface BinaryRun {
  /** The exit code, or `128 + signal number` when a signal ended it. */
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs `compact-profile` with `args` and collects its output; any exit code resolves. */
export async function runProfileBinary(
  args: readonly string[],
  options: BinaryOptions = {},
): Promise<BinaryRun> {
  const binary = await resolveProfileBinary(options);
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) =>
      reject(new Error(`cannot run ${binary}: ${error.message}`)),
    );
    child.on('close', (code, signal) =>
      resolve({
        exitCode: code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}
