import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Directory holding the suite's `compact.toml`, and therefore what
 * `CompactConfig.rootDir` resolves to for every deploy here. The wallet
 * pool passes the same value so pool-owned wallets anchor their state
 * where a deployer-owned one would.
 */
export const ROOT_DIR = resolve(HARNESS_DIR, '..');

export const CONFIG_PATH = resolve(ROOT_DIR, 'compact.toml');
export const ARTIFACTS_DIR = resolve(ROOT_DIR, 'fixtures/artifacts');
export const DEPLOYMENTS_DIR = resolve(ROOT_DIR, 'deployments/compact');

/** Fixtures `make compile` emits an artifact tree for. */
export type FixtureArtifact = 'Counter' | 'PrivateCounter';

/** Throw with the compile hint when `name`'s artifact is not on disk yet. */
export function requireArtifact(name: FixtureArtifact): void {
  const dir = resolve(ARTIFACTS_DIR, name);
  if (existsSync(dir)) return;
  throw new Error(
    `Missing compiled artifact at ${dir}.\nRun \`make compile\` from the repo root first.`,
  );
}

/** Reset the deployments directory between specs. */
export function wipeDeployments(): void {
  if (existsSync(DEPLOYMENTS_DIR)) {
    rmSync(DEPLOYMENTS_DIR, { recursive: true, force: true });
  }
}
