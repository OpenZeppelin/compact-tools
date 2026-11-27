# compact-mock

Mock contract generator for Compact modules. It reads the `[mock]` table of
`compact.toml`, parses each module with [`compact-tree-sitter`](../compact-tree-sitter),
and writes the test mocks that wrap it. Generated mocks are not committed: they land in
each module's `test/artifacts/` directory, which both repos ignore. `build` compiles them
with the `compact` toolchain.

## Install

- npm, no Rust toolchain needed: `yarn add --dev @openzeppelin/compact-mocker`. The
  package downloads the release binary for the host on first use. See
  [`packages/mocker`](../../packages/mocker).
- From source: `cargo install --path crates/compact-mock`.

## Quick start

Add a `[mock]` table to the `compact.toml` next to the `src` directory:

```toml
[mock]
caller_type = { name = "Caller", module = "identifier/Identifier" }

[mock.auth.prf]
module = "crypto/authentication/AuthPrfPseudonym"
call = 'authenticate(pad(32, "{salt}"))'

[[mock.rules]]
modules = ["**"]
auth = ["prf", "caller"]
```

```console
$ compact-mock build +0.36.0 --skip-zk
wrote src/access/test/artifacts/MockOwnable.compact
wrote src/access/test/artifacts/MockOwnableCaller.compact
compact-mock: 2 mocks, 2 written, 0 unchanged, 0 removed.
compiled src/access/test/artifacts/MockOwnable
compiled src/access/test/artifacts/MockOwnableCaller
compact-mock: 2 mocks compiled.
```

Specs import `./artifacts/MockOwnable/contract/index.js` from the module's `test/`
directory. `compact-compiler` runs this build by default when `compact.toml` has a
`[mock]` table (see [`packages/cli`](../../packages/cli)).

## Usage

```text
compact-mock generate [NAME]... [--config <FILE>] [--dir <DIR>]
compact-mock build [+<VERSION>] [NAME]... [--config <FILE>] [--dir <DIR>] [--skip-zk] [--compact-bin <PATH>]
```

| Option | Effect |
|---|---|
| `NAME...` | Only these mocks. An unknown name is an error. Nothing is removed. |
| `--config <FILE>` | The TOML file holding `[mock]`. Default: the nearest `compact.toml` upward. |
| `--dir <DIR>` | Only modules under `DIR`; stale removal stays inside it. Errors of modules outside it are ignored; config errors are not. A `DIR` with no module is a successful run. |
| `+<VERSION>` | Passed to `compact compile`. At most one. |
| `--skip-zk` | Passed to `compact compile`. `SKIP_ZK=true` does the same. |
| `--compact-bin <PATH>` | The `compact` executable. Env `COMPACT_MOCK_COMPACT_BIN`; default `compact`. |

`build` generates first, then runs `compact compile [+V] [--skip-zk] <dir>/<Mock>.compact
<dir>/<Mock>` per mock in expansion order and stops at the first failure.

Output:

- stdout: `wrote <path>`, `unchanged <path>`, `removed <path>`; `build` adds
  `compiled <dir>`. Paths are relative to the working directory when under it.
- stderr: `compact-mock: skipped <module>: not a module` (or `no exported circuits`),
  rules that apply to no module, the summary, and errors with `caused by:` lines.

## Exit codes

| Code | `generate` | `build` |
|---|---|---|
| 0 | success, zero mocks included | every mock compiled |
| 1 | never | `compact compile` failed; its output is printed |
| 2 | usage, config, source, plan, ownership or IO error; nothing written | the same, or `compact` could not start |

## Config

`compact-mock` reads only `[mock]` and the tables under it; they reject unknown keys.
Paths are relative to the config file, module paths and globs to `src`. The full
compact-contracts table is in [`examples/compact.toml`](examples/compact.toml).

### `[mock]`

| Key | Default | Meaning |
|---|---|---|
| `src` | `"src"` | Module root. |
| `test_dir` | `"{dir}/test"` | Each module's test directory. Must start with `{dir}/`. Discovery skips every directory with this tail. |
| `spdx` | none | SPDX line of every mock. |
| `caller_type` | none | `{ name, module }`: the struct or `new type` every authenticator returns. |
| `exclude` | `[]` | Module globs never generated: the mocks that stay hand-written. |

### `[mock.auth.<name>]`

| Key | Meaning |
|---|---|
| `module` | Authenticator module. |
| `call` | Call template. Its circuit must return `caller_type`. `{salt}` appears at most once, as `pad(<n>, "{salt}")` or `"{salt}"`, or not at all. |
| `prefix` | Import prefix; default `<module name>_`. |
| `suffix` | Goes into mock names; default `""`. |

The built-in `caller` keeps the caller a circuit argument; its table may set `suffix`
only (default `"Caller"`).

### `[mock.inject.<name>]`

Injectors fill parameters of another nominal type, such as a `Blinding`.

| Key | Meaning |
|---|---|
| `module`, `call`, `prefix` | As for an authenticator. `call` takes no placeholder. |
| `type` | `{ name, module }`: a struct, enum or `new type`. A `new type` never matches its underlying type. |
| `scope` | `"caller"` (default): only where an authenticator injected the caller in the same circuit. `"all"`: everywhere. |

### `[[mock.rules]]`

A module gets mocks when a rule's `modules` glob matches it, its `exclude_modules` does
not, and `[mock].exclude` does not. `*` stays in one path segment, `**` crosses them.

| Key | Meaning |
|---|---|
| `auth` | Authenticators, one mock each; default `["caller"]`. Ignored for a module with no caller parameter. |
| `inject` | Injectors this rule uses. |
| `name` | Template: `{module}`, `{instance}`, `{suffix}`, `{dir}`. Default `Mock{module}{instance}{suffix}`. |
| `prefix` | Module import prefix; default `<module name>_`. |
| `salt` | String (inside the slot's literal), `{ ledger = "<field>" }` or `{ expr = "<expression>" }`. Default: the mock's name. |
| `init` | `"auto"` (default), `"none"`, `"plain"`, or `{ flag, circuit }`. The init circuit defaults to `initialize`. |
| `module_args`, `circuit_args` | Generic arguments. |
| `exclude`, `disclose`, `guard`, `rename` | Per circuit. A `rename` key `name(T1, T2)` picks one overload. |
| `ledger` | `true`, `false`, or a field list. |
| `ledger_names` | `"prefixed"` (`<P><field>`) or `"plain"` (imported and exported bare). |
| `include` | `true` (the conventional fragment when it exists), `false`, or a file under `test_dir`. |
| `implements` | Interfaces: `[{ name, module }]`. |
| `instances` | `{ suffix, group?, prefix?, module_args?, circuit_args?, init?, salt?, exclude?, rename? }`. |
| `merge` | All instances in one mock. |
| `<auth name>` | Per-authenticator overrides, e.g. `prf.init = { flag = "isInit" }`. |

Precedence: rules apply in file order and a later rule replaces only the keys it sets.
Lists and tables replace whole. Per-authenticator tables apply next, instance keys last.
A circuit or ledger field a rule names must exist in some module the rule applies to; a
rule that applies to no module prints a note.

## Generated mocks

- **Re-export or wrapper.** A circuit that needs no change is re-exported. A wrapper is
  emitted for caller or injector injection, circuit generics, `disclose`, `guard`,
  `rename`, an overload, or a merged group. A circuit the module re-exports through
  `export { }` is spelled from the file that declares it.
- **Four import groups**, a blank line between them: the standard library, interfaces,
  named imports, module imports. A named import never has a prefix; a prefixed import
  names nothing. `contract implements <I>;` lines follow.
- **Export list.** Types the signatures need (never aliases or contract types), then
  re-exported circuits, then prefixed pure circuits of merged groups, then ledger fields.
- **Authenticated mocks** drop each caller-typed parameter and pass the authenticator
  call. The `caller` mock keeps it and never imports the authenticator. Matching fails
  closed: an unresolved parameter type, a type that contains the caller without being
  it, or two caller parameters in one circuit are errors.
- **Overloads.** The first declared keeps its name, the k-th becomes `<name><k>`, unless
  a `rename` key picks it by its parameter types.
- **Instances.** Each stand-alone instance is its own mock. A merged group imports the
  module once per instance, wraps every circuit as `<circuit><suffix>`, exports pure
  circuits as `<P><circuit>`, and has one constructor: shared parameters, then one
  `Boolean` per flag. Two instances with equal module arguments are an error.
- **Witness clash.** Two files the mock imports that declare one witness name are an
  error naming both: compactc binds them to one witness function.
- **Determinism.** No version or date in the output, so a tool upgrade alone changes no
  mock.

## Ownership

```text
src/<dir>/test/
├── MockX.fragment.compact    committed, never written by the tool
└── artifacts/                ignored
    ├── .compact-mock-stamp   names the tool owns here
    ├── MockX.compact         generate
    └── MockX/                build
```

- The tool writes only into an artifacts directory it creates, an empty one, or one with
  the stamp. Anything else fails the run before the first write.
- It deletes only `<N>.compact` and `<N>/` for a name the stamp lists that the full
  expansion no longer produces. NAME arguments disable deletion. Symlinks are removed as
  links. A directory left with only its stamp is removed.
- The stamp lists every new name before a source is written, so an interrupted run never
  leaves an unlisted file.

## Fragments

A fragment holds the hand-written rest of a mock: a ledger field, a constructor, a
helper circuit. `<test_dir>/<Mock>.fragment.compact` is included by convention as the
mock's last line, `include "../<Mock>.fragment";`.

- Imports inside a fragment resolve from the mock's directory, `test/artifacts/`. Write
  them as if the fragment sat there.
- The mock always imports the module under its prefix when it includes a fragment.
- A fragment that declares a `constructor` needs a mock without one (`init = "none"`, or
  no init circuit).
- A fragment's `export circuit` names count for `implements` and for `mock-coverage`.

## Fixing a `disclose` error from compactc

A wrapper or re-export that returns witness-derived data fails to compile with
`potential witness-value disclosure must be declared`. Add the circuit named after
`exported circuit` to `disclose` and build again.

## Migrating compact-contracts mocks

1. Append the `[mock]` table to the root `compact.toml`, starting from
   [`examples/compact.toml`](examples/compact.toml).
2. Delete each hand-written mock a rule replaces, and move what it has beyond forwards
   into a fragment.
3. Point artifact imports at `test/artifacts/<Mock>/contract/index.js`.
4. Run the unit specs unchanged. Fix differences in the config: `ledger = false` where
   a spec pins an empty public ledger, `rename`, `disclose`, an override table.

## Limits

- A spec that names a mock's artifact by a path string in its body keeps that mock
  hand-written.
- `implements` signatures are checked by compactc at `build`, not by the tool.
- An injector parameter that contains its type without being it is left as a parameter.
- An overloaded init circuit the constructor calls is an error.

## Tests

```sh
cargo test -p compact-mock
```

[`tests/fixtures/README.md`](tests/fixtures/README.md) lists the cases and how to bless
their expectations.
