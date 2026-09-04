import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * Artifact-directory resolution shared by the artifact loader and the
 * `Contract`-class resolver, so the two agree on which directory a TOML
 * `artifact` string names and which file is its entry point.
 */

/**
 * Resolve a TOML `artifact` value to a directory. Relative values are tried
 * against `rootDir` first so a path that already includes the artifacts
 * directory works, then under `artifactsDir`.
 */
export function resolveUnderRoot(
  rootDir: string,
  artifact: string,
  artifactsDir: string,
): string {
  if (isAbsolute(artifact)) return artifact;
  const direct = resolve(rootDir, artifact);
  if (existsSync(direct)) return direct;
  return resolve(rootDir, artifactsDir, artifact);
}

/**
 * First existing `index.{cjs,js}` under `<artifactDir>/contract` then
 * `<artifactDir>`. `.cjs` wins because compactc emits CommonJS.
 */
export function findArtifactEntry(artifactDir: string): string | undefined {
  const contractDir = resolve(artifactDir, 'contract');
  const candidates = [
    resolve(contractDir, 'index.cjs'),
    resolve(contractDir, 'index.js'),
    resolve(artifactDir, 'index.cjs'),
    resolve(artifactDir, 'index.js'),
  ];
  return candidates.find(existsSync);
}
