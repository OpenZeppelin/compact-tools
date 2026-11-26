# @openzeppelin/compact-launcher

Resolves the prebuilt Rust binary behind a Compact tools bin: an override, a per-user
cache, or a download from the GitHub release, verified against the digests the calling
package ships. [`@openzeppelin/compact-linter`](../linter),
[`@openzeppelin/compact-profiler`](../profiler) and
[`@openzeppelin/compact-mocker`](../mocker) depend on it.

## Usage

A package describes its binary once and finds its own root:

```ts
// src/launcher.ts
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleasedBinary } from '@openzeppelin/compact-launcher';

export const COMPACT_LINT: ReleasedBinary = {
  name: 'compact-lint',
  packageName: 'compact-linter',
  bin: 'compact-linter',
  overrideEnv: 'COMPACT_LINT_BINARY',
  downloadBaseEnv: 'COMPACT_LINT_DOWNLOAD_BASE',
};

// One level up from src/ and from dist/ alike; the root ships checksums.txt.
export const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
```

Its bin is then one call:

```ts
#!/usr/bin/env node
// src/compactLinter.ts
import { runBin } from '@openzeppelin/compact-launcher';
import { COMPACT_LINT, packageDir } from './launcher.ts';

process.exit(await runBin(COMPACT_LINT, packageDir, process.argv.slice(2)));
```

Library code that needs the path without running the binary resolves it the same way:

```ts
const path = await resolveBinary(hostOptions(COMPACT_LINT, packageDir));
```

## Running a bin

`runBin(binary, packageDir, args)` resolves the binary with `hostOptions` and runs it on
`args` with inherited stdio and `argv0` set to `binary.bin`. It returns the exit code to
pass on:

- the binary's own exit code;
- `128 + n` when signal `n` ends it;
- 2 when the binary cannot be resolved or started, after a message on stderr prefixed
  `<bin>: `.

`hostOptions(binary, packageDir)` reads the host's platform, architecture and C library,
`process.env`, the user cache under `packageName`, and the version from
`<packageDir>/package.json`. Its `notify` writes to stderr under the `<bin>: ` prefix.

## Resolution

`resolveBinary` returns the first of:

1. The executable that `env[overrideEnv]` names. It is run as given, unverified.
2. `<cacheDir>/<name>-<version>-<target>`, cached by an earlier run, when it is a regular
   file whose SHA-256 matches `<packageDir>/checksums.txt`. Every call hashes it again,
   which takes a few milliseconds for a release binary. A symlink or a file that does not
   match is reported through `notify` and replaced by step 3. A directory at that path is
   reported too; the rename onto it then fails and the download is discarded.
3. `<name>-<target>`, downloaded from the `<packageName>/v<version>` GitHub release, or
   from `env[downloadBaseEnv]` when set. Its SHA-256 must match `<packageDir>/checksums.txt`;
   the release's own `checksums.txt` is never read. It is then staged under a unique name
   and renamed into the cache path.

Without the override, `<packageDir>/checksums.txt` is required for a cache hit as well as
for a download. Its absence is an error that names `overrideEnv`.

`notify` is called before a download, and before a cached binary that fails verification
is replaced. Error messages carry no prefix; the caller adds its bin's name.

`resolveBinary` creates the cache directory with mode `0700`. A directory that already
exists keeps its mode.

### What verification does not cover

`resolveBinary` verifies the file and returns its path, and the caller then starts the
binary by that path. A process that can write the cache directory can swap the file in
between. When the directory is `0700`, only a process running as the same user, or root,
can do that.
Verification catches a binary planted or damaged before the run. It cannot catch one
swapped during it.

Prebuilt targets are `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
`x86_64-apple-darwin` and `aarch64-apple-darwin`. Any other host, musl Linux included,
is an error that names `crates/<name>` to build from source and `overrideEnv` to set.

`userCacheDir(name, platform, env, home)` is `~/Library/Caches/<name>` on macOS and
`$XDG_CACHE_HOME/<name>` or `~/.cache/<name>` elsewhere.

## Requirements

- Node.js >= 24
