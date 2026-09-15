import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** npm `platform-arch` pair to the Rust target triple the release assets are named after. */
const TARGETS: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

const RELEASE_BASE =
  'https://github.com/OpenZeppelin/compact-tools/releases/download';

/** A stalled release download fails instead of hanging the lint run. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Where the binary is fetched from and cached, and who is told about a download. */
export interface ResolveOptions {
  /** Root of the installed package; the cache lives under `.cache/` inside it. */
  packageDir: string;
  version: string;
  platform: string;
  arch: string;
  env: Record<string, string | undefined>;
  /** Called once, before the first download of a run. */
  notify: (message: string) => void;
}

export function resolveTarget(platform: string, arch: string): string | null {
  return TARGETS[`${platform}-${arch}`] ?? null;
}

export function assetName(target: string): string {
  return `compact-lint-${target}`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** `<sha256>  <asset>` lines to an asset-keyed map; CRLF and the `*` binary marker are tolerated. */
export function parseChecksums(text: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const line of text.split('\n')) {
    const entry = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (entry) {
      digests.set(entry[2], entry[1]);
    }
  }
  return digests;
}

export function expectedChecksum(text: string, asset: string): string {
  const digest = parseChecksums(text).get(asset);
  if (digest === undefined) {
    throw new Error(`checksums.txt has no entry for ${asset}`);
  }
  return digest;
}

/**
 * Path to the `compact-lint` executable, downloading it into the package cache when missing.
 *
 * Messages carry no `compact-lint:` prefix; the bin adds it.
 */
export async function resolveBinary(options: ResolveOptions): Promise<string> {
  const override = options.env.COMPACT_LINT_BINARY;
  if (override) {
    return override;
  }

  const target = resolveTarget(options.platform, options.arch);
  if (target === null) {
    throw new Error(
      `no prebuilt binary for ${options.platform}-${options.arch}; build from source with cargo (crates/compact-lint) and set COMPACT_LINT_BINARY`,
    );
  }

  const cacheDir = join(options.packageDir, '.cache');
  const cached = join(cacheDir, `compact-lint-${options.version}-${target}`);
  if (existsSync(cached)) {
    return cached;
  }

  const asset = assetName(target);
  const base =
    options.env.COMPACT_LINT_DOWNLOAD_BASE ??
    `${RELEASE_BASE}/compact-linter/v${options.version}`;
  options.notify(`downloading ${asset} (v${options.version})`);

  const [binary, checksums] = await Promise.all([
    fetchBytes(`${base}/${asset}`),
    fetchText(`${base}/checksums.txt`),
  ]);

  const expected = expectedChecksum(checksums, asset);
  const actual = sha256(binary);
  if (actual !== expected) {
    throw new Error(
      `checksum mismatch for ${asset}: expected ${expected}, got ${actual}; delete ${cached} and retry`,
    );
  }

  // Staged under a unique name so concurrent runs never read a half-written file.
  mkdirSync(cacheDir, { recursive: true });
  const staged = `${cached}.${randomUUID()}.tmp`;
  writeFileSync(staged, binary);
  chmodSync(staged, 0o755);
  renameSync(staged, cached);
  return cached;
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

async function fetchText(url: string): Promise<string> {
  return (await fetchOk(url)).text();
}
