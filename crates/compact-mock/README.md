# compact-mock

Mock contract generator for Compact modules. It reads `compact-mock.toml`, parses each
module with [`compact-tree-sitter`](../compact-tree-sitter), and writes the test mock
that wraps it: one mock per module, or two when the module takes a caller. Generated
mocks are committed, and `generate --check` fails CI when one drifts. The tool never
runs the compiler.

## Install

- npm, no Rust toolchain needed: `yarn add --dev @openzeppelin/compact-mocker`. The
  package downloads the release binary for the host on first use. See
  [`packages/mocker`](../../packages/mocker).
- From source: `cargo install --path crates/compact-mock`.

## Quick start

Put `compact-mock.toml` next to the `src` directory that holds your modules:

```toml
[auth]
module = "crypto/authentication/AuthPrfPseudonym"
call = 'authenticate(pad(32, "{salt}"))'
caller_type = { name = "Caller", module = "identifier/Identifier" }

[[mock]]
module = "access/Ownable"
```

```console
$ compact-mock generate
wrote src/access/test/mocks/MockOwnable.compact
wrote src/access/test/mocks/MockOwnableCaller.compact
compact-mock: 2 mocks, 2 written, 0 unchanged.
```

Commit both files, and check them in CI:

```sh
compact-mock generate --check
```

## Usage

```text
compact-mock generate [NAME]... [--config <FILE>] [--check]
compact-mock --version | --help
```

- `NAME`: generated mock names to restrict the run to, such as `MockOwnableCaller`. An
  unknown name is an error.
- `--config <FILE>`: use this file instead of searching upward from the working
  directory for `compact-mock.toml`. Relative paths inside a config are always anchored
  at the config's own directory.
- `--check`: write nothing. Render every mock in memory and compare it byte for byte
  with the file on disk.
- Every selected mock is planned before anything is written. Any planning error prints
  every error found and writes nothing.
- `generate` rewrites only the mocks whose text changed, and creates missing output
  directories. `--check` never creates one.

Output:

| Stream | `generate` | `generate --check` |
| --- | --- | --- |
| stdout | `wrote <path>` or `unchanged <path>` per mock | `missing <path>`, or `changed <path>` and a unified diff (3 lines of context). Silent when clean |
| stderr | `compact-mock: 2 mocks, 1 written, 1 unchanged.` | `compact-mock: 2 mocks up to date.` or `compact-mock: 1 of 2 mocks out of date; run compact-mock generate.` |

- Errors go to stderr as `compact-mock: <message>`, each followed by its
  `  caused by: <cause>` lines. More than one error ends with
  `compact-mock: <k> errors; nothing written.`
- Counts read `1 mock` in the singular.
- Paths print relative to the working directory when under it, otherwise absolute.

## Exit codes

- `0`: success, or `--check` found no drift.
- `1`: `--check` found drift.
- `2`: usage, config, IO, parse, planning or ownership error, `--check` included.

## Config

`compact-mock.toml`, one per consumer package. Every table rejects unknown keys. Names
(`name`, `prefix`, an `init` flag, a `rename` target) must match
`[A-Za-z_][A-Za-z0-9_]*`.

### Top level

| Key | Default | Meaning |
| --- | --- | --- |
| `src` | `"src"` | Directory that holds the modules. Must exist |
| `out_dir` | `"{dir}/test/mocks"` | Output directory, relative to `src`. `{dir}` is the module's directory relative to `src` (`.` at the root), `{parent}` its parent. No other placeholder |
| `spdx` | none | When set, line 1 of every mock is `// SPDX-License-Identifier: <spdx>`. One line |
| `[auth]` | absent | Turns on the authenticated and `*Caller` mocks |
| `[[mock]]` | at least one | One entry per module |

### `[auth]`

The tool has no auth layer of its own. The consumer names it here.

| Key | Default | Meaning |
| --- | --- | --- |
| `module` | required | Authenticator module, relative to `src`, without `.compact` |
| `prefix` | `<module declaration name>_` | Import prefix for the authenticator |
| `call` | required | Expression that yields a caller. Starts with an exported circuit of `module` and holds `{salt}` exactly once, inside a `"..."` string. The tool prepends `prefix` |
| `caller_type` | required | `{ name, module }`: the struct whose parameters get injected. Matched by declaration, so a prefixed spelling or an alias of it matches too |

### `[[mock]]`

| Key | Default | Meaning |
| --- | --- | --- |
| `module` | required | Module path relative to `src`, without `.compact`. No `.` or `..` segments |
| `name` | `Mock<file stem>` | Name of the authenticated or single mock. The `*Caller` mock is `<name>Caller` |
| `prefix` | `<module declaration name>_` | Prefix of the module import. Also spells the ledger exports (`CFT__balances`) |
| `out_dir` | top-level `out_dir` | Same placeholders |
| `module_args` | `[]` | Generic arguments for `module M<...>`, inserted verbatim. The count must match |
| `circuit_args` | `{}` | Circuit name to generic arguments, `initialize` included. Every exposed generic circuit needs one |
| `variants` | both | `["auth"]`, `["caller"]` or both |
| `init` | `"plain"` if the module exports `initialize`, else `"none"` | Constructor shape, see below |
| `exclude` | `[]` | Module circuits left out of the mock |
| `disclose` | `[]` | Circuits whose wrapper returns `disclose(...)`. Not for a circuit that returns `[]` |
| `guard` | `false` | `true` guards every exposed circuit, a list guards those named. A guarded wrapper first increments a private `_invocations: Counter` |
| `rename` | `{}` | `old = "new"` exposes circuit `old` as `new` |
| `ledger` | `true` | `false` leaves the module's exported ledger fields out of the mock's export list |
| `include` | `false` | `true` includes `<name>.fragment.compact` from the output directory. A string names another file there, ending in `.fragment.compact` |
| `salt` | the authenticated mock's name | Authenticated mock only |
| `[mock.auth]`, `[mock.caller]` | absent | Per-variant overrides |

- `variants`, `salt`, `[mock.auth]` and `[mock.caller]` need `[auth]` and a module with
  a caller-typed parameter.
- A variant table takes `name`, `init`, `exclude`, `disclose`, `guard`, `rename`,
  `include`, `ledger`, and `salt` (`[mock.auth]` only). Its key replaces the entry's;
  lists are not merged. Dotted keys work too: `auth.init = { flag = "isInit" }`.
- `[mock.auth].name` leaves the `*Caller` name alone: it stays `<name>Caller`.
- A circuit named in `exclude`, `disclose`, `guard`, `rename` or `circuit_args` must be
  an exported circuit of the module. `disclose`, `guard` and `rename` must also name one
  the mock exposes.

`init`:

| Value | Constructor |
| --- | --- |
| `"none"` | None. `initialize`, if any, stays a circuit. A fragment may declare the constructor |
| `"plain"` | Takes `initialize`'s parameters and calls it |
| `{ flag = "isInit" }` | Adds a trailing `isInit: Boolean` and calls `initialize` only when it is true |

With `"plain"` or a flag, `initialize` is not exposed as a circuit.

[`examples/compact-mock.toml`](examples/compact-mock.toml) is the config of
OpenZeppelin compact-contracts. The mocker's
[fixture config](../../packages/mocker/test/fixtures/compact-mock.toml) uses every key,
and its tests compile and simulate the result.

## Generated mocks

The quick start writes this `MockOwnable.compact`:

```typescript
// Generated by compact-mock from access/Ownable. Do not edit by hand.
// FOR TESTING PURPOSES ONLY. DO NOT deploy or use this contract in production.

pragma language_version >= 0.28.0;

import CompactStandardLibrary;

import { Identifier } from "../../../identifier/Identifier";
import "../../../crypto/authentication/AuthPrfPseudonym" prefix AuthPrfPseudonym_;
import {
  owner,
  _transferOwnership,
  _unsafeUncheckedTransferOwnership
} from "../../Ownable";
import "../../Ownable" prefix Ownable_;

export {
  ContractAddress,
  Either,
  owner,
  _transferOwnership,
  _unsafeUncheckedTransferOwnership,
  Ownable__isInitialized,
  Ownable__owner
};

constructor(initialOwner: Identifier) {
  Ownable_initialize(initialOwner);
}

export circuit transferOwnership(newOwner: Identifier): [] {
  return Ownable_transferOwnership(
    AuthPrfPseudonym_authenticate(pad(32, "MockOwnable")),
    newOwner
  );
}

export circuit _unsafeTransferOwnership(newOwner: Identifier): [] {
  return Ownable__unsafeTransferOwnership(
    AuthPrfPseudonym_authenticate(pad(32, "MockOwnable")),
    newOwner
  );
}

export circuit renounceOwnership(): [] {
  return Ownable_renounceOwnership(
    AuthPrfPseudonym_authenticate(pad(32, "MockOwnable"))
  );
}

export circuit assertOnlyOwner(): [] {
  return Ownable_assertOnlyOwner(
    AuthPrfPseudonym_authenticate(pad(32, "MockOwnable"))
  );
}
```

- **Re-export or wrapper.** A circuit that needs no change is re-exported, so its
  signature is the module's own. A wrapper is emitted only for caller injection, circuit
  generics, `disclose`, `guard` or `rename`.
- **One module instance.** The selective import and the prefixed import spell the same
  path and generic arguments, so they share one instance and one ledger state.
- **Export list.** First the types the signatures need, sorted, with aliases expanded
  (`Identifier` becomes `Either` and `ContractAddress`). Then the re-exported circuits.
  Then the module's exported ledger fields as `<prefix><field>`, unless `ledger = false`.
- **`MockOwnableCaller`** re-exports every circuit with its `Caller` parameter and
  exports `Caller`. It never imports the authenticator.
- **Ownership.** A line among the first three that starts with
  `// Generated by compact-mock` marks the file as the tool's. A file at a target path
  without it is never overwritten: `generate` and `--check` both refuse it with exit 2.
  Delete or move the hand-written mock first.
- **Determinism.** No tool version or date in the output, so upgrading the tool causes
  no drift by itself.

### Authenticated and `*Caller` mocks

With `[auth]` set, a module whose exported circuits (or `initialize`) take a parameter of
`caller_type` gives two mocks:

- `<name>` drops each such parameter and passes `<auth prefix><call>` in its place, at
  the same position.
- `<name>Caller` keeps the parameter, so a test passes the caller as an argument.

The salt is the text that replaces `{salt}`: the mock's name, unless `salt` is set. It
must be 1 to 32 UTF-8 bytes (`pad(32, ...)` takes no more), with no `"`, `\` or control
character. A longer derived name is an error:

```text
compact-mock: MockOwnableWithAnEvenLongerNameHere: salt "MockOwnableWithAnEvenLongerNameHere" is 35 bytes; pad(32, ...) takes at most 32. Set salt
```

Caller matching fails closed under `[auth]`:

- A parameter type that does not resolve is an error, even in an excluded circuit.
- A type that contains the caller type without being it (`Maybe<Caller>`) is an error
  in the authenticated mock. Add that circuit to `exclude`.

A module with no caller-typed parameter gives one mock with no injection. Without
`[auth]`, every module gives one mock and caller parameters pass through.

## Fixing a `disclose` error from compactc

A wrapper or re-export that returns witness-derived data fails to compile:

```text
Exception: Pseudonym.compact line 19 char 5:
  potential witness-value disclosure must be declared but is not:
    witness value potentially disclosed:
      the return value of witness wit_PseudonymSK at line 10 char 3
    nature of the disclosure:
      the value returned from exported circuit authenticate might disclose a hash of the
      witness value
```

Add the circuit named after `exported circuit` to `disclose`, then run `generate` again:

```toml
[[mock]]
module = "auth/Pseudonym"
disclose = ["authenticate"]
```

## Fragments

A fragment holds the hand-written rest of a mock: an extra ledger field, a constructor,
a helper circuit.

- `include = true` makes the mock end with `include "<name>.fragment";`, which loads
  `<name>.fragment.compact` from the output directory. compactc appends `.compact`
  itself, hence the double suffix.
- The fragment is yours. The tool never writes or checks its content, but it must exist
  and parse. A fragment that declares a `constructor` needs `init = "none"`.
- `include = true` on an entry with two variants gives each variant its own fragment.
- A fragment does not compile on its own. `compact-compiler` excludes nothing by
  default, so add `--exclude '*.fragment.compact'` to every `compact-compiler` run that
  walks the mocks. The builder's default `Mock*` exclude covers a `Mock*` fragment only
  while you pass no `--exclude` of your own.

## Formatting and line endings

- Mocks have their own layout: an import, export list or call wraps one item per line
  past 80 columns. That is not what `compact format` writes, so keep the formatter and
  its `--check` off generated mocks.
- The comparison is byte-exact, with `\n` line endings. On Windows checkouts, add
  `*.compact text eol=lf` to `.gitattributes`, or `--check` reports every mock as
  changed.

## Migrating compact-contracts mocks

Per module:

1. Add a `[[mock]]` entry to `contracts/compact-mock.toml`, starting from
   [`examples/compact-mock.toml`](examples/compact-mock.toml).
2. Delete the hand-written mock, since the tool refuses to overwrite it.
3. Run `compact-mock generate`, compile, and run the module's specs unchanged.
4. Fix failures in the config: `ledger = false` when a spec pins an empty public ledger
   (Ownable), `rename` for a circuit the old mock exposed under another name, `disclose`
   per compactc, and a variant table for a difference on one variant only.
5. With the first fragment, add `--exclude '*.fragment.compact'` to the compile scripts.

The simulators can drop their forwarding methods at the same time: see
[Flat circuit methods](../../packages/simulator/README.md#4-flat-circuit-methods).

## Limits

- A mock holding several instances of one module stays hand-written.
- So does a mock that injects more than the caller, such as an instance salt or a
  blinding.
- `initialize` is the only constructor circuit the tool recognizes.
- A circuit the module re-exports from another file through `export { }` is
  re-exported as is. One that needs a wrapper is an error: exclude it.
- `ledger` is all or nothing.
- A marked file that no entry produces any more is not reported. Delete it by hand.
- The 32-byte salt limit assumes `pad(32, ...)` in `call`.
- `--check` proves the files match the config, not that they compile.

## Tests

```sh
cargo test -p compact-mock
```

[`tests/fixtures/README.md`](tests/fixtures/README.md) lists the cases and how to bless
their expectations.
