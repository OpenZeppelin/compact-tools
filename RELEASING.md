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

## Changelog

Each published package keeps its own `CHANGELOG.md`, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Any PR with a
consumer-visible change adds an entry under that package's `## Unreleased`
heading, with the PR number in parentheses. Mark API breaks with a
`**Breaking:**` prefix.

Beta bumps leave the entries under `## Unreleased`. When a cycle graduates to
stable, rename the heading to `## <version> (YYYY-MM-DD)` and land that before
running the workflow from `main`, so the published tarball and the GitHub
release notes agree.

## Running the workflow

1. Go to "Release Package" in Actions.
2. Click on the "Run workflow" dropdown menu.
3. Pick the branch: `main` for a stable release, `beta` for a prerelease.
4. Choose the package to release and the version bump type.
   Following [SemVer](https://semver.org/):
   - **Patch** - Backward-compatible bug fixes.
   - **Minor** - New functionality in a backward-compatible way.
   - **Major** - Breaking API changes.
   - **Prepatch / preminor / premajor** - Open a new beta cycle at the
     corresponding bump (`0.3.1` + preminor -> `0.4.0-beta.0`).
   - **Prerelease** - Advance the current beta cycle (`0.4.0-beta.0` ->
     `0.4.0-beta.1`). From a stable version it behaves like prepatch.

5. The CI will automatically:
   - Run tests.
   - Bump the version.
   - Open a release PR against the branch you ran from, and auto-merge it.
6. Once the release PR merges, a maintainer must approve the publish. The CI
   then:
   - Creates a git tag.
   - Publishes the package to npm under the channel's dist-tag.
7. Once published, go to "Releases" and create a GitHub release using the
   generated tag. Mark beta tags as prereleases. `compact-linter` and
   `compact-profiler` are the exceptions: the workflow creates their releases
   itself (see below).

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

`compact-cli` depends on `compact-builder` and `compact-deployer`. The other
published packages have no internal dependencies:

```text
compact-cli (bin wrapper)
  ├─ depends on compact-builder
  └─ depends on compact-deployer
compact-builder (library)
compact-deployer (library)
compact-linter (bin wrapper around the compact-lint crate)
compact-profiler (bin wrapper around the compact-profile crate, and a library)
compact-simulator (library)
```

The `workspace:^` deps are rewritten by yarn into the resolved versions at
`yarn pack` time. For the very first release, publish in dependency order so
each dependent finds its deps already on npm:

1. `compact-builder` (no internal deps)
2. `compact-simulator` (no internal deps)
3. `compact-deployer` (no internal deps)
4. `compact-linter` (no internal deps)
5. `compact-profiler` (no internal deps)
6. `compact-cli` (depends on `compact-builder` and `compact-deployer`; pull
   `main` first so both bump commits are present locally before triggering)

After the first release, the five packages version independently — bump any
one of them in isolation without re-publishing the others.

A package's first publish authenticates with the `NPM_TOKEN` secret from the
`compact-npm-prod` environment, since a Trusted Publisher can only be
registered against a package npm already knows. Register it on npmjs.org right
after that publish; the workflow then takes the OIDC path for every later
version on its own.

## Rust-binary packages

`compact-linter` and `compact-profiler` are bin wrappers around a Rust crate, so
each release carries native binaries as well as an npm package.

| Package | Directory | Crate | Binary and asset prefix |
| --- | --- | --- | --- |
| `compact-linter` | `packages/linter` | `crates/compact-lint` | `compact-lint` |
| `compact-profiler` | `packages/profiler` | `crates/compact-profile` | `compact-profile` |

- The version lives in two files: the package's `package.json` and the crate's
  `Cargo.toml`. The release workflow bumps the package, mirrors the value into the
  crate, refreshes `Cargo.lock`, and commits all three. A unit test in each
  package fails when the two drift.
- The publish workflow builds four binaries before publishing, one per target, each
  on its own runner:

  | Target | Runner |
  | --- | --- |
  | `x86_64-unknown-linux-gnu` | `ubuntu-24.04` |
  | `aarch64-unknown-linux-gnu` | `ubuntu-24.04-arm` |
  | `x86_64-apple-darwin` | `macos-15-intel` |
  | `aarch64-apple-darwin` | `macos-15` |

- It then creates the GitHub release `<package>/v<version>`, for example
  `compact-linter/v<version>`, with the four `<binary>-<target>` assets and a
  `checksums.txt`, and only then publishes to npm. The installed package downloads
  its binary from that release, so the assets must be there first. For every other
  package the GitHub release is still created by hand (step 7 above).
- The npm package carries the same `checksums.txt` and checks every download against
  it, so a release asset replaced later fails on install.
- A re-run never replaces assets. It fails when the version's tag names another
  commit. When the release already exists, it keeps the release's assets and ships
  their `checksums.txt`. A release missing an asset has to be deleted before the
  re-run.
- Release notes come from the `## <version>` section of the `CHANGELOG.md` in the
  package's directory, falling back to the tag name. A `beta` dist-tag marks the
  release a prerelease.
- Each package's first publish takes the `NPM_TOKEN` path above. Right after it, add
  the package (`@openzeppelin/compact-linter`, `@openzeppelin/compact-profiler`) as a
  Trusted Publisher on npmjs.org, naming this repo and
  `.github/workflows/release-publish.yml`.
