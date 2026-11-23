import { createHash } from 'node:crypto';

/** npm `platform-arch` pair to the Rust target triple the release assets are named after. */
const TARGETS: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

export function resolveTarget(platform: string, arch: string): string | null {
  return TARGETS[`${platform}-${arch}`] ?? null;
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
