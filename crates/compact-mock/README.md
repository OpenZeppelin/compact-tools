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
modules = ["access/Ownable"]
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

$ compact-mock generate
unchanged src/access/test/artifacts/MockOwnable.compact
unchanged src/access/test/artifacts/MockOwnableCaller.compact
compact-mock: 2 mocks, 0 written, 2 unchanged, 0 removed.
```

- `MockOwnable` authenticates the caller with `AuthPrfPseudonym`. `MockOwnableCaller`
  takes the caller as a circuit argument.
- Specs import `./artifacts/MockOwnable/contract/index.js` from the module's `test/`
  directory.
- Widen `modules` to `["**"]` for every module under `src`. Generic modules and circuits
  without arguments are skipped with a note. A module that needs `disclose` or a fragment
  then needs its own rule, or a `[mock].exclude` entry; the run names each one. See
  [compact-contracts](#compact-contracts).
- `compact-compiler` runs this build by default (see [Compiler default](#compiler-default)).

## Usage

```text
compact-mock generate [NAME]... [--config <FILE>] [--dir <DIR>] [--only <GLOB>]...
compact-mock build [+<VERSION>] [NAME]... [--config <FILE>] [--dir <DIR>] [--only <GLOB>]... [--skip-zk] [--compact-bin <PATH>] [-- <ARGS>...]
```

| Option | Effect |
|---|---|
| `NAME...` | Only these mocks. An unknown name is an error. Nothing is removed. |
| `--config <FILE>` | The TOML file holding `[mock]`. Default: the nearest `compact.toml` upward. |
| `--dir <DIR>` | Only modules under `DIR`; stale removal stays inside it. Errors of modules outside it are ignored; config errors are not. A `DIR` with no module is a successful run. A `DIR` outside `src`, or one that reaches it through a symlink, prints a note and writes nothing. |
| `--only <GLOB>` | Only mocks whose module source or generated source the glob matches, with `compact-compiler --only` syntax: `*` spans `/`, and a glob without `/` matches the file name. Repeatable. Nothing is removed. |
| `+<VERSION>` | Passed to `compact compile`. At most one. |
| `--skip-zk` | Passed to `compact compile`. `SKIP_ZK=true` does the same. |
| `--compact-bin <PATH>` | The `compact` executable. Env `COMPACT_MOCK_COMPACT_BIN`; default `compact`. |
| `-- <ARGS>...` | Passed to every `compact compile`, before the paths. |

`build` generates first, then runs `compact compile [+V] [--skip-zk] [ARGS] <dir>/<Mock>.compact
<dir>/<Mock>` per mock in expansion order and stops at the first failure. compactc's
stderr streams through; its stdout is printed only when it fails.

Output:

- stdout: `wrote <path>`, `unchanged <path>`, `removed <path>`; `build` adds
  `compiled <dir>`. Paths are relative to the working directory when under it.
- stderr: `compact-mock: skipped <module>: <reason>` and other notes (a rule or exclude
  pattern that matches nothing, a skipped generic circuit, a stale entry kept, a stamp
  ignored), the summary, and errors with `caused by:` lines.

## Exit codes

| Code | `generate` | `build` |
|---|---|---|
| 0 | success, zero mocks included | every mock compiled |
| 1 | never | `compact compile` failed; its output is printed |
| 2 | usage, config, source, plan, ownership or IO error; nothing written | the same errors, nothing written; or `compact` could not start, after the sources were written |

## Config

`compact-mock` reads only `[mock]` and the tables under it; they reject unknown keys.
Every other table of `compact.toml` is ignored. Paths are relative to the config file,
module paths and globs to `src`.

### `[mock]`

| Key | Default | Meaning |
|---|---|---|
| `src` | `"src"` | Module root, inside the config file's directory. |
| `test_dir` | `"{dir}/test"` | Each module's test directory. Must start with `{dir}/`. Discovery skips every directory with this tail. |
| `spdx` | none | SPDX line of every mock. |
| `caller_type` | none | `{ name, module }`: the struct or `new type` every authenticator returns. |
| `exclude` | `[]` | Module globs never generated: the mocks that stay hand-written. |

### `[mock.auth.<name>]`

Authenticators. A rule's `auth` list gives one mock per name.

| Key | Meaning |
|---|---|
| `module` | Authenticator module. Required. |
| `call` | Call template. Required. Its circuit must return `caller_type`. `{salt}` appears at most once, as `pad(<n>, "{salt}")` or `"{salt}"`, or not at all. |
| `prefix` | Import prefix; default `<module name>_`. |
| `suffix` | Goes into mock names; default `""`. |
| `params` | Names of the caller-typed parameters the call replaces; default `["caller"]`. A caller-typed parameter under another name stays a circuit argument. |

- Names match `[a-z][a-z0-9_]*` and are never a rule key.
- An authenticator needs `[mock].caller_type`.
- The built-in `caller` keeps the caller a circuit argument. Its table may set `suffix`
  only (default `"Caller"`).

### `[mock.inject.<name>]`

Injectors fill parameters of another nominal type, such as a `Blinding`.

| Key | Meaning |
|---|---|
| `module`, `call`, `prefix` | As for an authenticator. `call` takes no placeholder and must return `type`. |
| `type` | `{ name, module }`: a struct, enum or `new type`. A `new type` never matches its underlying type. |
| `scope` | `"caller"` (default): only where an authenticator injected the caller in the same circuit. `"all"`: everywhere. |
| `params` | Names of the `type` parameters the call replaces; default the table's name, e.g. `["blinding"]`. |

A rule may not list two injectors for one type.

### `[[mock.rules]]`

A rule applies to a module when a `modules` glob matches it and no `exclude_modules`
glob does. A module gets mocks when some rule applies and `[mock].exclude` does not match
it. `*` stays in one path segment, `**` crosses them.

| Key | Meaning |
|---|---|
| `modules` | Module globs. Required. |
| `exclude_modules` | Module globs this rule skips. |
| `auth` | Authenticators, one mock each; default `["caller"]`. Ignored for a module with no caller parameter. |
| `inject` | Injectors this rule uses. |
| `name` | Name template. See [Naming](#naming). |
| `prefix` | Module import prefix; default `<module name>_`. |
| `salt` | See [Salts](#salts). |
| `init` | See [Constructor](#constructor). |
| `module_args`, `circuit_args` | Generic arguments: a list, and a table of lists keyed by circuit. |
| `exclude`, `disclose`, `rename` | Per circuit. A `rename` key `name(T1, T2)` picks one overload. |
| `guard` | `true` for every exposed circuit, or a list of circuits. |
| `ledger` | `true` (default), `false`, or a list of exported fields. |
| `ledger_names` | `"prefixed"` (`<P><field>`) or `"plain"` (imported and exported bare). `"plain"` does not combine with a merged group. |
| `include` | `true` (the conventional fragment when it exists), `false`, or a `.fragment.compact` file under `test_dir`. |
| `implements` | Interfaces: `[{ name, module }]`. |
| `instances` | See [Instances](#instances-and-merge). |
| `merge` | All instances in one mock. Needs `instances`. |
| `<auth name>` | A per-authenticator table, e.g. `prf.init = { flag = "isInit" }`. |

A per-authenticator table sets only `inject`, `salt`, `init`, `exclude`, `disclose`,
`guard`, `rename`, `ledger`, `ledger_names`, `include` and `implements`. The `caller`
table takes no `salt`.

### Precedence

- Rules apply in file order. A later rule replaces only the keys it sets.
- Lists and tables replace whole; they never merge.
- Per-authenticator tables apply next, in file order. Instance keys apply last.
- A circuit or ledger field a rule names must exist in some module that gets mocks from
  it, so a module `[mock].exclude` removes does not count.
- A rule that applies to no module, and an `exclude` or `exclude_modules` pattern that
  excludes nothing, print a note and the run goes on.
- When no rule lists a module's exact path, globs only: a generic module without
  `module_args`, or one whose constructor would call a generic init circuit without
  `circuit_args`, is skipped with a note. A generic circuit without `circuit_args` is left
  out of the mock with a note. A rule that lists the exact path turns both into errors.

### Naming

Default template: `Mock{module}{instance}{suffix}`.

| Placeholder | Value |
|---|---|
| `{module}` | The module's file name, e.g. `Ownable`. |
| `{instance}` | The instance `suffix`; the `group` name for a group; empty for `merge = true`. |
| `{suffix}` | The authenticator's `suffix`. |
| `{dir}` | The module's directory, each segment capitalized: `crypto/authentication` gives `CryptoAuthentication`. |

Two mocks with one name, ignoring case, are an error that suggests `{dir}` or
`{instance}`.

### Salts

The salt fills the `{salt}` slot of an authenticator's `call`.

| Value | Effect |
|---|---|
| none | The mock's name, inside the slot's literal. |
| `"<text>"` | The text, inside the slot's literal. Checked against the `pad(<n>, ...)` width. |
| `{ ledger = "<field>" }` | Replaces the slot with the module's exported ledger field. |
| `{ expr = "<expression>" }` | Replaces the slot with the expression. No width check. |

A rule `salt` is ignored where the call has no slot. A `<name>.salt` for an authenticator
whose call has no slot is an error. A `ledger` or `expr` salt is an error when the
constructor passes an authenticated caller to the init circuit: the salt is not set until
that circuit runs. Use a string salt or `init = "none"`.

### Constructor

| `init` | Constructor |
|---|---|
| `"auto"` (default) | Calls the init circuit with its parameters when the module exports it. |
| `"plain"` | As `"auto"`, but some module the rule applies to must export the init circuit. |
| `"none"` | None. The init circuit is exposed like any other. |
| `{ flag, circuit }` | `flag` adds a `Boolean` parameter that gates the call. `circuit` names the init circuit; default `initialize`. |

The constructor consumes the init circuit: the mock does not expose it.

### Instances and merge

`instances` is a list of tables with `suffix` (required) and optional `group`, `prefix`,
`module_args`, `circuit_args`, `init`, `salt`, `exclude` and `rename`.

- Each instance without a `group` is its own mock.
- Instances with one `group` share one mock. `merge = true` puts every instance in one.
- A merged mock imports the module once per instance. The prefix defaults to
  `<module name><suffix>_`.
- It wraps every circuit as `<circuit><suffix>` and exports pure circuits as
  `<P><circuit>`.
- It has one constructor: shared parameters (same name and type), then one `Boolean` per
  flag.
- Two instances with equal module arguments are an error: compactc would share one
  instance. Numeric literals compare by value (`8` equals `0x8`).

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
- **Authenticated mocks** drop each caller-typed parameter that `params` names and pass
  the authenticator call. The `caller` mock keeps it and never imports the authenticator.
  Matching fails closed: an unresolved parameter type, a type that contains the caller
  without being it, or two injected callers in one circuit are errors.
- **Overloads.** The first declared keeps its name, the k-th becomes `<name><k>`, unless
  a `rename` key picks it by its parameter types.
- **`implements`.** The mock must expose every circuit the interface declares, with the
  interface's parameter count and types after injection. A missing circuit is an error
  that names the fragment to add it to. A mismatch is an error; set `implements` per
  authenticator (`caller.implements`) when an injected caller is the difference.
- **Witness clash.** Two files the mock imports or includes (its fragment) that declare
  one witness name are an error naming both: compactc binds them to one witness function.
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

- Each module directory gets its own `artifacts/`, holding only that directory's mocks.
- The tool writes only into an artifacts directory it creates, an empty one, or one with
  the stamp. Anything else fails the run before the first write.
- A stamp counts only in `<module dir>/<test_dir>/artifacts`. A stamp anywhere else is
  ignored with a note.
- A symlink between `src` and an artifacts directory, that directory included, is an
  error. The tool never writes or deletes through one.
- A file it would write that the stamp does not list and that lacks the generated header
  is an error; it is never overwritten.
- It deletes only `<N>.compact` and `<N>/` for a name the stamp lists that the full
  expansion no longer produces, and only when the file starts with the generated header
  and the directory holds only compiled output (`compiler`, `contract`, `keys`, `zkir`).
  Anything else, a symlink included, is kept with a note. A name that differs only in
  case from one the run produces is never deleted. NAME and `--only` arguments disable
  deletion. A directory left with only its stamp is removed.
- The stamp lists every new name before a source is written, so an interrupted run never
  leaves an unlisted file.
- A run with any config, source or plan error writes nothing.

## Fragments

A fragment holds the hand-written rest of a mock: a ledger field, a constructor, a
helper circuit. `<test_dir>/<Mock>.fragment.compact` is included by convention as the
mock's last line, `include "../<Mock>.fragment";`.

- Imports inside a fragment resolve from the mock's directory, `test/artifacts/`. Write
  them as if the fragment sat there.
- The mock always imports the module under its prefix when it includes a fragment.
- A fragment that declares a `constructor` needs a mock without one (`init = "none"`, or
  no init circuit).
- A fragment's `export circuit` names count for `implements` and for `mock-coverage`. A
  fragment constructor counts as covering the init circuit.
- A fragment's `witness` declarations join the witness clash check.

## Compiler default

`compact-compiler` from [`@openzeppelin/compact-cli`](../../packages/cli) runs
`compact-mock build` before its own compile when the nearest `compact.toml` has a `[mock]`
table.

- It passes its `+<version>`, `--skip-zk`, search directory (`--src`, `--dir`) and each
  `--only` on, and its other compiler flags after `--`.
- Its own walk excludes `*/<test_dir>/artifacts/*` (`*/test/artifacts/*` by default) and
  `*.fragment.compact`.
- `--no-mocks` skips the build and keeps the excludes.
- `COMPACT_MOCK_BINARY` names the binary; otherwise `@openzeppelin/compact-mocker` must
  be installed.
- `compact-builder` never builds mocks, and always excludes the same files from its
  compile and its copy to `dist/`.

## Lint rule

`compact-lint` reports `mock-coverage` (default `warn`) when `compact.toml` has a `[mock]`
table:

- a module under `src` with an exported circuit that no rule matches and `[mock].exclude`
  does not list;
- a module a glob rule skips as generic;
- an exported circuit that none of its module's mocks exposes;
- a `[mock]` table that fails to load, as one finding on `compact.toml`.

It plans with this crate and writes nothing. See
[`crates/compact-lint`](../compact-lint/README.md#rules).

## compact-contracts

[`examples/compact.toml`](examples/compact.toml) is the table that generates the
compact-contracts unit mocks. A trimmed excerpt:

```toml
[mock]
src = "contracts/src"
spdx = "MIT"
caller_type = { name = "Caller", module = "identifier/Identifier" }
exclude = ["archive/**", "crypto/prf/*"]  # ... trimmed

[mock.auth.prf]
module = "crypto/authentication/AuthPrfPseudonym"
call = 'authenticate(pad(32, "{salt}"))'

[mock.inject.blinding]
module = "crypto/randomness/RandBlinding"
type = { name = "Blinding", module = "crypto/randomness/RandBlinding" }
call = "read()"

[[mock.rules]]
modules = ["**"]
auth = ["prf", "caller"]

[[mock.rules]]
modules = ["access/ShieldedAccessControl"]
salt = { ledger = "_instanceSalt" }
inject = ["blinding"]

[[mock.rules]]
modules = ["math/UintN"]
merge = true
guard = true
instances = [
  { suffix = "0", prefix = "U0_", module_args = ["0"] },
  # ... trimmed
  { suffix = "248", prefix = "U248_", module_args = ["248"] },
]

# ... more rules
```

Migrating:

1. Append the `[mock]` table to the root `compact.toml`, starting from the example.
2. Delete each hand-written mock a rule replaces, and move what it has beyond forwards
   into a fragment.
3. Point artifact imports at `test/artifacts/<Mock>/contract/index.js`.
4. Run the unit specs unchanged. Fix differences in the config: `ledger = false` where
   a spec pins an empty public ledger, `rename`, `disclose`, an override table.

## Fixing a `disclose` error from compactc

A wrapper or re-export that returns witness-derived data fails to compile with
`potential witness-value disclosure must be declared`. Add the circuit named after
`exported circuit` to `disclose` and build again.

## Limits

- A spec that names a mock's artifact by a path string in its body keeps that mock
  hand-written.
- `implements` compares types by the declaration each name resolves to, and skips the
  type check for a generic circuit. compactc checks the rest at `build`.
- A plain `rename` key on an overloaded name renames the first overload only.
- A merged group exports an overloaded pure circuit only through its wrappers.
- An injector parameter that contains its type without being it is left as a parameter.
- An overloaded init circuit the constructor calls is an error.
- `build` compiles every selected mock on each run; there is no cache.

## Tests

```sh
cargo test -p compact-mock
```

[`tests/fixtures/README.md`](tests/fixtures/README.md) lists the cases and how to bless
their expectations.
