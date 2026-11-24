# @openzeppelin/compact-launcher

Resolves the prebuilt Rust binary behind a Compact tools bin: an override, a per-user
cache, or a download from the GitHub release, verified against the digests the calling
package ships. [`@openzeppelin/compact-linter`](../linter) and
[`@openzeppelin/compact-profiler`](../profiler) depend on it.

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

1. The executable that `env[overrideEnv]` names.
2. `<cacheDir>/<name>-<version>-<target>`, cached by an earlier run. A cached binary is
   not checked again.
3. `<name>-<target>`, downloaded from the `<packageName>/v<version>` GitHub release, or
   from `env[downloadBaseEnv]` when set. Its SHA-256 must match `<packageDir>/checksums.txt`;
   the release's own `checksums.txt` is never read. It is then cached.

`notify` is called once, before a download. Error messages carry no prefix; the caller
adds its bin's name.

Prebuilt targets are `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
`x86_64-apple-darwin` and `aarch64-apple-darwin`. Any other host, musl Linux included,
is an error that names `crates/<name>` to build from source and `overrideEnv` to set.

`userCacheDir(name, platform, env, home)` is `~/Library/Caches/<name>` on macOS and
`$XDG_CACHE_HOME/<name>` or `~/.cache/<name>` elsewhere.

## Requirements

- Node.js >= 24
