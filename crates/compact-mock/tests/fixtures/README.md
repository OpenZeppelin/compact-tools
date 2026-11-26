# Test fixtures

One directory per case. A case holds the inputs (configs and `src/`) and, per run, two
expectations under `expected/`: `<run>.txt` (exit code, stdout, stderr) and `<run>/`
(every file the run creates or changes, at its path). `tests/cli.rs` names the runs.
`tests/diagnostics.rs` reuses the same cases and matches single stderr lines.

- `ownable-pair`: vendored `access/Ownable` and its imports, see `NOTICE`. `default` is
  the design's authenticated and `*Caller` text byte for byte, `no-auth` the single mock,
  `ledger` the `ledger` key with a variant override. `utils/Utils` is absent on purpose:
  the plan never needs it.
- `unmarked-file`: a hand-written file at a target path, and a config whose target is
  the module source. Both are refused and nothing is written.
- `rules`: `calc/*` modules for `disclose`, `guard`, `rename`, `exclude`, `include`,
  `init`, their errors, an error batch, and the `--check` edits.
- `generics`: module and circuit generic arguments and their arity errors.
- `types`: type spelling, the export list, module export lists, hidden types, and the
  standard-type allow-list.
- `auth-layer`: a synthetic authenticator (`auth/Gate`, `who/Who`) for caller matching,
  variant expansion and overrides, salts, name filtering and the `[auth]` errors.
- `rebase`: import paths from each output directory, `out_dir` templates, and a module
  outside `src`.
- `diagnostics`: configs and broken sources for the remaining error rows.
- `parser`: sources the `source.rs` unit tests read.

The synthetic sources are written to parse, not to compile.

## Bless

After an intended change to the output, rewrite the expectations of the affected tests
and review the diff. Name the tests: an unfiltered bless also rewrites `ownable-pair`,
which must keep the design's text. Run one thread, since several tests share a run.

```sh
COMPACT_MOCK_BLESS=1 cargo test -p compact-mock --test cli rules:: -- --test-threads=1
```
