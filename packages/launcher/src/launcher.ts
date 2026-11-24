import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { constants, homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { expectedChecksum, resolveTarget, sha256 } from './release.ts';

const RELEASE_BASE =
  'https://github.com/OpenZeppelin/compact-tools/releases/download';

/** A stalled release download fails instead of hanging the run. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** The names a prebuilt binary is released, cached and overridden under. */
export interface ReleasedBinary {
  /** The executable, its release asset prefix and its crate under `crates/`, as `compact-lint`. */
  name: string;
  /** Unscoped npm package name: the release tag prefix and the cache directory, as `compact-linter`. */
  packageName: string;
  /** The npm bin that runs it: its `argv0` and the prefix of its messages, as `compact-linter`. */
  bin: string;
  /** Names an executable to run instead of downloading, as `COMPACT_LINT_BINARY`. */
  overrideEnv: string;
  /** Names a base URL to fetch the asset from instead of the GitHub release. */
  downloadBaseEnv: string;
}

/** Where the binary is fetched from and cached, and who is told about a download. */
export interface ResolveOptions {
  binary: ReleasedBinary;
  /** Root of the installed package, which carries the release's `checksums.txt`. */
  packageDir: string;
  /** Per-user directory the binary is cached in, never inside the installed package. */
  cacheDir: string;
  version: string;
  platform: string;
  arch: string;
  /** Whether the host's C library is musl; every Linux asset links glibc. */
  musl: boolean;
  env: Record<string, string | undefined>;
  /** Called once, before the first download of a run. */
  notify: (message: string) => void;
}

/**
 * `name` under the user's cache: `~/Library/Caches` on macOS, `$XDG_CACHE_HOME` or
 * `~/.cache` elsewhere. The installed package can be read-only (Yarn Plug'n'Play, a
 * global install).
 */
export function userCacheDir(
  name: string,
  platform: string,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === 'darwin') {
    return join(home, 'Library', 'Caches', name);
  }
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, '.cache'), name);
}

/** Node reports a glibc version only when it runs on glibc. */
export function isMusl(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  const report = process.report.getReport() as {
    header?: { glibcVersionRuntime?: string };
  };
  return report.header?.glibcVersionRuntime === undefined;
}

/**
 * `resolveBinary` options for this process: its host, environment and user cache, and the
 * version in `<packageDir>/package.json`. Notices go to stderr under the bin's prefix.
 */
export function hostOptions(
  binary: ReleasedBinary,
  packageDir: string,
): ResolveOptions {
  return {
    binary,
    packageDir,
    cacheDir: userCacheDir(
      binary.packageName,
      process.platform,
      process.env,
      homedir(),
    ),
    version: packageVersion(packageDir),
    platform: process.platform,
    arch: process.arch,
    musl: isMusl(),
    env: process.env,
    notify: (message) => process.stderr.write(`${binary.bin}: ${message}\n`),
  };
}

function packageVersion(packageDir: string): string {
  const path = join(packageDir, 'package.json');
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    typeof manifest === 'object' &&
    manifest !== null &&
    'version' in manifest &&
    typeof manifest.version === 'string'
  ) {
    return manifest.version;
  }
  throw new Error(`${path} has no version`);
}

/**
 * A bin's body: resolves the binary with `hostOptions` and runs it on `args`, stdio
 * inherited. Returns the exit code to pass on: the binary's, `128 + n` when signal `n` ends
 * it, or 2 after a prefixed message when it cannot be resolved or started.
 */
export async function runBin(
  binary: ReleasedBinary,
  packageDir: string,
  args: readonly string[],
): Promise<number> {
  const fail = (message: string): number => {
    process.stderr.write(`${binary.bin}: ${message}\n`);
    return 2;
  };

  let path: string;
  try {
    path = await resolveBinary(hostOptions(binary, packageDir));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  // argv0 keeps the cache file name out of the binary's own usage output.
  const result = spawnSync(path, args, { argv0: binary.bin, stdio: 'inherit' });
  if (result.error) {
    return fail(`cannot run ${path}: ${result.error.message}`);
  }
  if (result.signal) {
    return 128 + (constants.signals[result.signal] ?? 0);
  }
  return result.status ?? 0;
}

/**
 * Path to the binary's executable, downloading it into the user cache when missing.
 *
 * Messages carry no prefix; the caller adds it.
 */
export async function resolveBinary(options: ResolveOptions): Promise<string> {
  const { binary } = options;
  const override = options.env[binary.overrideEnv];
  if (override) {
    return override;
  }

  const fromSource = `build from source with cargo (crates/${binary.name}) and set ${binary.overrideEnv}`;
  if (options.platform === 'linux' && options.musl) {
    throw new Error(
      `no prebuilt binary for musl Linux, the release binaries need glibc; ${fromSource}`,
    );
  }

  const target = resolveTarget(options.platform, options.arch);
  if (target === null) {
    throw new Error(
      `no prebuilt binary for ${options.platform}-${options.arch}; ${fromSource}`,
    );
  }

  const cached = join(
    options.cacheDir,
    `${binary.name}-${options.version}-${target}`,
  );
  if (existsSync(cached)) {
    return cached;
  }

  // Digests come from the package, never the release, so a replaced asset fails here.
  const asset = `${binary.name}-${target}`;
  const expected = expectedChecksum(
    packagedChecksums(options.packageDir, binary.overrideEnv),
    asset,
  );
  const base =
    options.env[binary.downloadBaseEnv] ??
    `${RELEASE_BASE}/${binary.packageName}/v${options.version}`;
  options.notify(`downloading ${asset} (v${options.version})`);

  const bytes = await fetchBytes(`${base}/${asset}`);
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${asset}: expected ${expected}, got ${actual}`,
    );
  }

  // Staged under a unique name so concurrent runs never read a half-written file.
  mkdirSync(options.cacheDir, { recursive: true });
  const staged = `${cached}.${randomUUID()}.tmp`;
  writeFileSync(staged, bytes);
  chmodSync(staged, 0o755);
  renameSync(staged, cached);
  return cached;
}

function packagedChecksums(packageDir: string, overrideEnv: string): string {
  const path = join(packageDir, 'checksums.txt');
  if (!existsSync(path)) {
    throw new Error(
      `${path} is missing, so a download cannot be verified; set ${overrideEnv}`,
    );
  }
  return readFileSync(path, 'utf8');
}

async function fetchOk(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`download failed for ${url}: ${reason}`);
  }
  if (!response.ok) {
    throw new Error(`download failed for ${url}: HTTP ${response.status}`);
  }
  return response;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetchOk(url)).arrayBuffer());
}
