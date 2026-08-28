/**
 * Releasable workspaces, keyed by their directory under `packages/`.
 *
 * Both release workflows resolve names and directories through here, so
 * adding a package to the release rotation is a one-line change.
 */
export const RELEASABLE = {
  builder: 'compact-builder',
  cli: 'compact-cli',
  simulator: 'compact-simulator',
};

/** Workflow input name (`compact-cli`) to workspace directory (`cli`). */
export function dirForPackage(name) {
  const dir = Object.keys(RELEASABLE).find((key) => RELEASABLE[key] === name);
  if (!dir) {
    throw new Error(`unknown package: ${name}`);
  }
  return dir;
}

/** Workspace directory (`cli`) to workflow input name (`compact-cli`). */
export function packageForDir(dir) {
  const name = RELEASABLE[dir];
  if (!name) {
    throw new Error(`unknown package directory: ${dir}`);
  }
  return name;
}

/**
 * Resolve the released workspace from the `packages/*\/package.json` paths a
 * merge touched.
 *
 * A release commit bumps exactly one package. Two or zero means the merge was
 * not the one the publish workflow expected, and guessing which to ship would
 * publish the wrong thing.
 */
export function dirFromChangedFiles(paths) {
  const bumps = paths
    .map((path) => path.trim())
    .filter((path) => /^packages\/[^/]+\/package\.json$/.test(path));

  if (bumps.length !== 1) {
    throw new Error(
      `expected exactly one packages/*/package.json change, found ${bumps.length}${
        bumps.length ? `: ${bumps.join(', ')}` : ''
      }`,
    );
  }

  const dir = bumps[0].split('/')[1];
  packageForDir(dir);
  return dir;
}
