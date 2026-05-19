import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const INTEGRATION_DIR = resolve(HARNESS_DIR, '..');

export const CONFIG_PATH = resolve(INTEGRATION_DIR, 'compact.toml');
export const ARTIFACT_DIR = resolve(
  INTEGRATION_DIR,
  'fixtures/artifacts/Counter',
);
export const DEPLOYMENTS_DIR = resolve(INTEGRATION_DIR, 'deployments/compact');

/** Throw with a helpful hint if the fixture hasn't been compiled yet. */
export function requireFixtureArtifact(): void {
  if (existsSync(ARTIFACT_DIR)) return;
  throw new Error(
    `Missing compiled artifact at ${ARTIFACT_DIR}.\n` +
      'Run `make -C tests/integrations compile` first.',
  );
}

/** Reset the deployments directory between specs. */
export function wipeDeployments(): void {
  if (existsSync(DEPLOYMENTS_DIR)) {
    rmSync(DEPLOYMENTS_DIR, { recursive: true, force: true });
  }
}
