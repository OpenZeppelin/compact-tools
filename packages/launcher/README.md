# @openzeppelin/compact-launcher

Resolves the prebuilt Rust binary behind a Compact tools bin: an override, a per-user
cache, or a download from the GitHub release, verified against the digests the calling
package ships. [`@openzeppelin/compact-linter`](../linter) and
[`@openzeppelin/compact-profiler`](../profiler) depend on it.

## Usage

```ts
import { homedir } from 'node:os';
import { isMusl, resolveBinary, userCacheDir } from '@openzeppelin/compact-launcher';

const COMPACT_LINT = {
  name: 'compact-lint',
  packageName: 'compact-linter',
  overrideEnv: 'COMPACT_LINT_BINARY',
  downloadBaseEnv: 'COMPACT_LINT_DOWNLOAD_BASE',
};

const binary = await resolveBinary({
  binary: COMPACT_LINT,
  packageDir, // root of the installed package, which ships checksums.txt
  cacheDir: userCacheDir(COMPACT_LINT.packageName, process.platform, process.env, homedir()),
  version, // the package's version, which is also the release's
  platform: process.platform,
  arch: process.arch,
  musl: isMusl(),
  env: process.env,
  notify: (message) => process.stderr.write(`compact-linter: ${message}\n`),
});
```

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
