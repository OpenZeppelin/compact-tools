# Releasing

## Running the workflow

1. Go to "Release Package" in Actions.
2. Click on the "Run workflow" dropdown menu.
3. Choose the package to release and the version bump type.
   Following [SemVer](https://semver.org/):
   - **Patch** - Backward-compatible bug fixes.
   - **Minor** - New functionality in a backward compatible way.
   - **Major** - Breaking API changes.

4. A maintainer must approve the release before it proceeds.
5. Once approved, the CI will automatically:
   - Run tests.
   - Bump the version.
   - Create a git tag.
   - Publish the package to npm.
6. Once published, go to "Releases" and create a GitHub release using the generated tag.

## Adding a package to the rotation

Both workflows resolve package names and directories through
`scripts/release/packages.mjs`. Add the workspace to the `RELEASABLE` map
there, then add its name to the `package` choice list in `release.yml` and
`release-publish.yml`. `yarn test:scripts` covers the resolver.

## First-release order

There's a one-step dependency chain across the three published packages:

```text
compact-cli (bin wrapper)
  └─ depends on compact-builder
compact-builder (library)
compact-simulator (library)
```

The `workspace:^` dep is rewritten by yarn into the resolved version at
`yarn pack` time. For the very first release, publish in dependency order so
each dependent finds its deps already on npm:

1. `compact-builder` (no internal deps)
2. `compact-simulator` (no internal deps)
3. `compact-cli` (depends on `compact-builder`; pull `main` first so the bump
   commit is present locally before triggering)

After the first release, the three packages version independently — bump any
one of them in isolation without re-publishing the others.
