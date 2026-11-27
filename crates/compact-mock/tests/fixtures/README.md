# Test fixtures

One directory per case. A case holds the inputs (configs with a `[mock]` table, and
`src/`) and, per run, two expectations under `expected/`:

- `<run>.txt`: the exit code, stdout, stderr, then `--- removed` and every path the run
  deleted (only when it deleted any). `build` runs add `--- compact calls`, one line per
  call of the stub `compact`.
- `<run>/`: every file the run creates or changes, at its path, stamps included.

`tests/cli.rs` names the runs. A run with no `--config` reads the case's `compact.toml`.
`tests/diagnostics.rs` reuses the cases and matches single stderr lines.

The root `.gitignore` hides `artifacts/`, so a path segment `artifacts` is spelled
`_artifacts` in inputs and expectations. The harness maps it both ways. Avoid the other
names that file hides (`build`, `dist`, `log`, `coverage`, `gen`, `vendor`, ...) for
cases and directories.

- `ownable-pair`: vendored `access/Ownable` and its imports, see `NOTICE`. `default` is
  the authenticated and caller mock pair, `no-auth` the single mock without
  `caller_type`, `ledger` the `ledger` key with a `caller` table. `utils/Utils` is absent
  on purpose: the plan never needs it.
- `rules`: `calc/*` modules for `disclose`, `guard`, `rename`, `exclude`, `include`,
  `init`, their errors, an overloaded `initialize` under the constructor, and an error
  batch. Fragments sit in `test/` and `test/shared/`.
- `generics`: module and circuit generic arguments and their arity errors.
- `types`: type spelling, the export list, module export lists, hidden types, and the
  standard-type allow-list.
- `auth-layer`: a synthetic authenticator (`auth/Gate`, `who/Who`, and `auth/Listed`
  and `auth/Relay` that export it through `export { }`) for caller matching, `hub/*`
  re-exports of the caller type, per-authenticator tables, salts, name filtering and the
  authenticator errors.
- `rebase`: import paths from each artifacts directory, a nested `test_dir`, and a module
  importing outside `src`.
- `globs`: rules that fold, a per-authenticator table, `[mock].exclude`,
  `exclude_modules`, skip lines for a preset and a module without circuits, and files a
  test directory or a fragment name keeps from discovery.
- `authenticators`: two named authenticators (one without a salt slot), injectors with
  `scope = "caller"` and `"all"` on a SAC-shaped module, ledger and expression salts.
- `instances`: stand-alone instances, and merged groups in the `UintN` and
  `Multisig 2To3And3To3` shapes.
- `overload`: automatic overload names and a per-signature rename.
- `export-list-wrapper`: a wrapper for a circuit the module re-exports, respelled from
  the file that declares it.
- `implements`: an interface met by re-exports and a fragment circuit, and a missing one.
- `witness-clash`: one witness name from two files, and one declaration reached twice.
- `fragment-import`: a fragment whose import is written from the artifacts directory.
- `ownership`: a stamped directory with stale names, an unlisted file and a non-name
  line, and an emptied directory. Tests add links and unstamped states in setup.
- `selection`: `{dir}` in names, duplicate names, `--dir` scope and zero mocks.
- `toolchain`: modules for the `build` tests, which run a stub `compact`.
- `diagnostics`: configs and broken sources for the remaining error rows.
- `parser`: sources the `source.rs` unit tests read.

The sources of `ownable-pair`, `rules`, `generics`, `types`, `auth-layer`, `rebase` and
`diagnostics` are written to parse, not to compile. Every mock the other cases expect
compiles with `compact compile +0.36.0 --skip-zk`.

## Bless

After an intended change to the output, rewrite the expectations of the affected tests
and review the diff. Name the tests, so a bless rewrites no expectation you did not mean
to change. Run one thread, since several tests share a run.

```sh
COMPACT_MOCK_BLESS=1 cargo test -p compact-mock --test cli rules:: -- --test-threads=1
```
