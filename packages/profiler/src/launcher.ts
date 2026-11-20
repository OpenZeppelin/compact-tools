import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { constants, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBinary, userCacheDir } from './binary.ts';

// One level up from src/ and from dist/ alike, so both entry points find the manifest.
const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));

function packageVersion(): string {
  const manifest = readFileSync(join(packageDir, 'package.json'), 'utf8');
  return (JSON.parse(manifest) as { version: string }).version;
}

/** Node reports a glibc version only when it runs on glibc. */
function isMusl(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  const report = process.report.getReport() as {
    header?: { glibcVersionRuntime?: string };
  };
  return report.header?.glibcVersionRuntime === undefined;
}

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
  return resolveBinary({
    packageDir,
    cacheDir: userCacheDir(process.platform, process.env, homedir()),
    version: packageVersion(),
    platform: process.platform,
    arch: process.arch,
    musl: isMusl(),
    env: process.env,
    notify: (message) => process.stderr.write(`compact-profile: ${message}\n`),
  });
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
