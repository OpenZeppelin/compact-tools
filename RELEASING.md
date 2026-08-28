# Releasing

## Channels

Two release channels, keyed to the branch the workflow runs from:

| Branch | Versions        | npm dist-tag | Install with              |
| ------ | --------------- | ------------ | ------------------------- |
| `main` | `0.3.2`         | `latest`     | `yarn add <pkg>`          |
| `beta` | `0.3.2-beta.0`  | `beta`       | `yarn add <pkg>@beta`     |

The dist-tag is derived from the version string, so a prerelease can never
take over `latest`. The bump strategies are pinned to their branch: `pre*`
runs only from `beta`, `patch`/`minor`/`major` only from `main`.

## Running the workflow

1. Go to "Release Package" in Actions.
2. Click on the "Run workflow" dropdown menu.
3. Pick the branch: `main` for a stable release, `beta` for a prerelease.
4. Choose the package to release and the version bump type.
   Following [SemVer](https://semver.org/):
   - **Patch** - Backward-compatible bug fixes.
   - **Minor** - New functionality in a backward compatible way.
   - **Major** - Breaking API changes.
   - **Prepatch / preminor / premajor** - Open a new beta cycle at the
     corresponding bump (`0.3.1` + preminor -> `0.4.0-beta.0`).
   - **Prerelease** - Advance the current beta cycle (`0.4.0-beta.0` ->
     `0.4.0-beta.1`). From a stable version it behaves like prepatch.

5. A maintainer must approve the release before it proceeds.
6. Once approved, the CI will automatically:
   - Run tests.
   - Bump the version.
   - Open a release PR against the branch you ran from, and auto-merge it.
   - Create a git tag.
   - Publish the package to npm under the channel's dist-tag.
7. Once published, go to "Releases" and create a GitHub release using the
   generated tag. Mark beta tags as pre-releases.

## Graduating a beta to stable

The bump strategies read the version already in `package.json`, so promote in
this order:

1. Merge `beta` into `main`, carrying the `-beta.N` version with it.
2. Run "Release Package" from `main` with `patch`, `minor`, or `major`. Each
   drops the prerelease suffix: `0.4.0-beta.3` + patch -> `0.4.0`.

Use `patch` to ship the beta's version as-is. Use `minor` or `major` only when
the final release warrants a higher bump than the beta cycle assumed.

A full cycle, starting from `0.3.1` on `main`:

| Branch | Bump         | Version        | dist-tag |
| ------ | ------------ | -------------- | -------- |
| `beta` | `preminor`   | `0.4.0-beta.0` | `beta`   |
| `beta` | `prerelease` | `0.4.0-beta.1` | `beta`   |
| `beta` | `prerelease` | `0.4.0-beta.2` | `beta`   |
| `main` | `patch`      | `0.4.0`        | `latest` |

The `pre*` bump names the version the cycle is heading for, so pick it from
what the finished release will be rather than from the size of the first beta:
`prepatch` for a bugfix, `preminor` for new features, `premajor` for a
breaking change. After that, only `prerelease` moves the counter. Running
`preminor` again mid-cycle starts a new one (`0.4.0-beta.2` -> `0.5.0-beta.0`).

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
