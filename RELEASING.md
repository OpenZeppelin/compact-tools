# Releasing

## Before triggering the workflow

For each PR that lands in `main` since the last release, add a bullet to the
`## Unreleased` section of the relevant `packages/<pkg>/CHANGELOG.md`. At
release time, the maintainer renames the `## Unreleased` heading to
`## <new-version> - YYYY-MM-DD` and opens a fresh `## Unreleased` block. This
step is currently manual — see the TODO below for the planned migration to
[changesets](https://github.com/changesets/changesets).

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

## First-release order

There's a dependency chain across the four published packages:

```
compact-tools (umbrella)
  ├─ depends on compact-tools-builder
  ├─ depends on compact-tools-cli
  └─ depends on compact-tools-simulator
compact-tools-cli (bin wrapper)
  └─ depends on compact-tools-builder
compact-tools-builder (library)
compact-tools-simulator (library)
```

Each `workspace:^` dep is rewritten by yarn into the resolved version at
`yarn pack` time. For the very first release, publish in dependency order so
each dependent finds its deps already on npm:

1. `compact-tools-builder` (no internal deps)
2. `compact-tools-simulator` (no internal deps)
3. `compact-tools-cli` (depends on `-builder`; pull `main` first so the bump
   commit is present locally)
4. `compact-tools` (umbrella; pull `main` first so the bumps for `-builder`,
   `-cli`, and `-simulator` are present)

After the first release, the four packages version independently — bump any
one of them in isolation without re-publishing the others.

## TODO: migrate to changesets

Today the version bump (via `yarn version` in the workflow input) and the
`CHANGELOG.md` entries are maintained separately and manually. As PR volume
grows this gets brittle — easy to forget a CHANGELOG entry, easy to mis-bump.

[Changesets](https://github.com/changesets/changesets) is the standard
monorepo tool for this:

- Contributors run `yarn changeset` in their PR and pick which packages bump
  and at what semver level, with a short description that becomes the
  CHANGELOG entry.
- A release workflow consumes all accumulated changesets to:
  - Compute correct per-package version bumps.
  - Write per-package `CHANGELOG.md` entries.
  - Open a "Version Packages" PR for review.
  - On merge, tag and publish all affected packages in one run.

The existing `release.yml` would be simplified: no manual `version_bump`
input, no per-run package selection — the accumulated changesets drive both.
Existing `CHANGELOG.md` files become the historical record; changesets manage
new entries from that point on.