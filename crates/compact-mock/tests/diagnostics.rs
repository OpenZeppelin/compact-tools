//! Every diagnostic the generator prints, each produced by a real run and matched by its
//! exact text.
//!
//! A row names a fixture case, an optional edit to the copied tree, the arguments
//! (subcommand first), the exit code, and one line the run must print to stderr. The
//! cause lines that follow some messages carry OS, TOML or glob text and are not compared.

use std::path::{Path, PathBuf};
use std::process::Command;

use assert_cmd::prelude::*;
use tempfile::TempDir;

/// Exit code for a usage, config, IO, parse, planning or ownership error.
const EXIT_ERROR: i32 = 2;

/// Exit code for a failed `compact compile`.
const EXIT_COMPILE: i32 = 1;

/// Stands for the temporary directory in a message.
const ROOT: &str = "<root>";

/// Variables the binary reads. Every run starts without them.
const SCRUBBED: [&str; 2] = ["SKIP_ZK", "COMPACT_MOCK_COMPACT_BIN"];

struct Row {
    /// The fixture case to copy, or `None` for an empty directory.
    case: Option<&'static str>,
    /// An edit to the copied tree before the run.
    setup: Option<fn(&Path)>,
    /// The subcommand and its arguments.
    args: &'static [&'static str],
    code: i32,
    /// Run with stdout a pipe whose reader is closed.
    closed_stdout: bool,
    /// One stderr line, without the `compact-mock: ` prefix.
    message: &'static str,
}

const fn row(case: &'static str, args: &'static [&'static str], message: &'static str) -> Row {
    exits(case, args, EXIT_ERROR, message)
}

const fn exits(
    case: &'static str,
    args: &'static [&'static str],
    code: i32,
    message: &'static str,
) -> Row {
    Row {
        case: Some(case),
        setup: None,
        args,
        code,
        closed_stdout: false,
        message,
    }
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Copies `from` into `to`, leaving out the expectations and spelling `_artifacts` as
/// `artifacts`.
fn copy(from: &Path, to: &Path) {
    for entry in std::fs::read_dir(from).expect("the case is readable") {
        let path = entry.expect("the entry is readable").path();
        let name = path.file_name().expect("a file name").to_owned();
        if name == "expected" {
            continue;
        }
        let target = if name == "_artifacts" {
            to.join("artifacts")
        } else {
            to.join(&name)
        };
        if path.is_dir() {
            std::fs::create_dir_all(&target).expect("dirs are created");
            copy(&path, &target);
        } else {
            std::fs::copy(&path, &target).expect("the input is copied");
        }
    }
}

/// Copies a row's case into a fresh directory and applies its setup.
fn prepare(row: &Row) -> TempDir {
    let directory = TempDir::new().expect("a temporary directory");
    if let Some(case) = row.case {
        copy(&fixtures().join(case), directory.path());
    }
    if let Some(setup) = row.setup {
        setup(directory.path());
    }
    directory
}

/// Runs a row in `directory` and returns its exit code and stderr, with the directory
/// shown as [`ROOT`].
fn run_in(directory: &Path, row: &Row) -> (i32, String) {
    let mut command = Command::cargo_bin("compact-mock").expect("the binary is built");
    command.current_dir(directory).args(row.args);
    for name in SCRUBBED {
        command.env_remove(name);
    }
    if row.closed_stdout {
        let (reader, writer) = std::io::pipe().expect("a pipe");
        drop(reader);
        command.stdout(writer);
    }
    let output = command.output().expect("the binary ran");
    let root = directory
        .canonicalize()
        .expect("the directory exists")
        .display()
        .to_string();
    let stderr = String::from_utf8(output.stderr)
        .expect("stderr is UTF-8")
        .replace(&root, ROOT);
    (output.status.code().expect("not signalled"), stderr)
}

fn run(row: &Row) -> (i32, String) {
    let directory = prepare(row);
    run_in(directory.path(), row)
}

/// Every row whose run does not exit with its code and print its line.
fn failures(rows: &[Row]) -> Vec<String> {
    let mut found = Vec::new();
    for row in rows {
        let (code, stderr) = run(row);
        let line = format!("compact-mock: {}", row.message);
        if code != row.code || !stderr.lines().any(|printed| printed == line) {
            found.push(format!(
                "{:?} {:?}: exit {code} (want {}), expected line\n  {line}\nstderr:\n{stderr}",
                row.case, row.args, row.code
            ));
        }
    }
    found
}

/// A stamped artifacts directory for `src/near`, with a directory where `MockNear.compact`
/// goes.
fn directory_at_target(root: &Path) {
    let artifacts = root.join("src/near/test/artifacts");
    std::fs::create_dir_all(artifacts.join("MockNear.compact")).expect("a directory blocks");
    std::fs::write(artifacts.join(".compact-mock-stamp"), "MockNear\n").expect("stamped");
}

fn unstamped(root: &Path) {
    std::fs::remove_file(root.join("src/lib/test/artifacts/.compact-mock-stamp"))
        .expect("the stamp is removed");
}

const ROWS: &[Row] = &[
    // config
    Row {
        case: None,
        setup: None,
        args: &["generate"],
        code: EXIT_ERROR,
        closed_stdout: false,
        message: "no compact.toml in <root> or any parent; pass --config <FILE>",
    },
    row(
        "diagnostics",
        &["generate", "--config", "missing.toml"],
        "cannot read config missing.toml",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "bad-syntax.toml"],
        "cannot parse config bad-syntax.toml",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "no-mock.toml"],
        "config no-mock.toml has no [mock] table",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "bad-key.toml"],
        "config bad-key.toml: [mock]: unknown field `exlcude`, expected one of `src`, `test_dir`, `spdx`, `caller_type`, `exclude`, `auth`, `inject`, `rules`",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "bad-shape.toml"],
        "config bad-shape.toml: [[mock.rules]] #1: invalid value: string \"sometimes\", expected \"auto\", \"none\", \"plain\" or { flag, circuit }",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "no-rules.toml"],
        "config no-rules.toml: [mock] has no [[mock.rules]] entry",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "test-dir.toml"],
        "config test-dir.toml: test_dir \"test\" must start with {dir}/ and use no other placeholder, no .. and no absolute path",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "bad-module.toml"],
        "config bad-module.toml: module \"ok/Ok.compact\" is a path relative to src, without .compact",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "src-missing.toml"],
        "config src-missing.toml: src directory sources does not exist",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "src-absolute.toml"],
        "config src-absolute.toml: src \"/compact-mock-missing-src\" must be a path relative to the config file",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "bad-prefix.toml"],
        "config bad-prefix.toml: [[mock.rules]] #1: prefix \"1st\" is not an identifier",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "bad-suffix.toml"],
        "config bad-suffix.toml: [mock.auth.caller].suffix \"a-b\" may hold only letters, digits and _",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "spdx.toml"],
        "config spdx.toml: spdx must be a single line",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "bad-glob.toml"],
        "config bad-glob.toml: [[mock.rules]] #1: invalid glob \"ok/[Ok\"",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "no-modules.toml"],
        "config no-modules.toml: [[mock.rules]] #1 has no modules",
    ),
    exits(
        "diagnostics",
        &["generate", "--config", "unused-rule.toml"],
        0,
        "config unused-rule.toml: [[mock.rules]] #2 applies to no module under src",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "unknown-rule-key.toml"],
        "config unknown-rule-key.toml: [[mock.rules]] #1: unknown key exlcude; not a rule key or an authenticator name",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "rule-circuit.toml"],
        "config rule-circuit.toml: [[mock.rules]] #1: exclude names nope, which no module the rule applies to exports",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "rule-ledger.toml"],
        "config rule-ledger.toml: [[mock.rules]] #1: ledger names _nope, which no module the rule applies to exports as a ledger field",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "rule-init.toml"],
        "config rule-init.toml: [[mock.rules]] #1: init = \"plain\", but no module the rule applies to exports initialize",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "auth-undefined.toml"],
        "config auth-undefined.toml: [[mock.rules]] #1: auth names nope, which [mock.auth] does not define",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "inject-undefined.toml"],
        "config inject-undefined.toml: [[mock.rules]] #1: inject names nope, which [mock.inject] does not define",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "merge-needs.toml"],
        "config merge-needs.toml: [[mock.rules]] #1: merge needs instances",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "plain-merge.toml"],
        "config plain-merge.toml: [[mock.rules]] #1: ledger_names = \"plain\" does not combine with a merged group",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "instance-key.toml"],
        "config instance-key.toml: [[mock.rules]] #1: instance \"A\" sets guard, which an instance cannot set",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "suffix-twice.toml"],
        "config suffix-twice.toml: [[mock.rules]] #1: instance suffix \"A\" appears twice",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "name-placeholder.toml"],
        "config name-placeholder.toml: [[mock.rules]] #1: name \"Mock{name}\" has an unknown placeholder {name}",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "injectors-one-type.toml"],
        "config injectors-one-type.toml: [[mock.rules]] #1: injectors first and second both stand in for Token",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "caller-salt.toml"],
        "config caller-salt.toml: [[mock.rules]] #1: salt does not apply to the caller authenticator",
    ),
    row(
        "authenticators",
        &["generate", "--config", "no-salt-slot.toml"],
        "config no-salt-slot.toml: [[mock.rules]] #1: ecdsa.salt is set, but [mock.auth.ecdsa].call takes no salt",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "include-file.toml"],
        "config include-file.toml: [[mock.rules]] #1: include \"Ok.extra\" must name a .fragment.compact file under the test directory",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "salt-expr.toml"],
        "config salt-expr.toml: [[mock.rules]] #1: salt expr must be one non-empty line",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "auth-rule-key.toml"],
        "config auth-rule-key.toml: authenticator name exclude is a rule key; pick another name",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "auth-name.toml"],
        "config auth-name.toml: authenticator or injector name Gate must match [a-z][a-z0-9_]*",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "caller-table.toml"],
        "config caller-table.toml: [mock.auth.caller] may set only suffix",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "auth-fields.toml"],
        "config auth-fields.toml: [mock.auth.gate] needs module and call",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "salt-placeholder.toml"],
        "config salt-placeholder.toml: [mock.auth.gate].call: {salt} may appear once, as pad(<n>, \"{salt}\") or \"{salt}\"",
    ),
    row(
        "authenticators",
        &["generate", "--config", "auth-needs-caller-type.toml"],
        "config auth-needs-caller-type.toml: [mock.auth.prf] needs [mock].caller_type",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "inject-placeholder.toml"],
        "config inject-placeholder.toml: [mock.inject.token].call takes no placeholder",
    ),
    row(
        "selection",
        &["generate", "--config", "name-dup.toml"],
        "config name-dup.toml: two mocks are named MockCore (ignoring case), from access/Core and token/Core; add {dir} or {instance} to the name template",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "derived-name.toml"],
        "config derived-name.toml: name template \"Mock{module}{instance}{suffix}\" gives \"Mockmy-module\" for bad/my-module, which is not an identifier",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "expansion.toml", "MockNope"],
        "no mock named MockNope in expansion.toml",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "ok.toml", "--dir", "nope"],
        "--dir nope does not exist",
    ),
    // source
    row(
        "diagnostics",
        &["generate", "--config", "unreadable.toml"],
        "cannot read src/bad/Binary.compact",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "broken.toml"],
        "src/bad/Broken.compact:7:10: parse error",
    ),
    row(
        "rules",
        &["generate", "--config", "include-errors.toml"],
        "src/calc/test/Broken.fragment.compact:4:1: parse error",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "twice.toml"],
        "src/bad/Twice.compact: expected one module declaration, found 2",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "no-pragma.toml"],
        "src/bad/NoPragma.compact: no pragma to copy into the mock",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "lost-without-auth.toml"],
        "src/door/Lost.compact: import \"../gone/Gone\" does not resolve to src/gone/Gone.compact",
    ),
    // authenticators, injectors and the caller type
    row(
        "auth-layer",
        &["generate", "--config", "auth-call.toml"],
        "[mock.auth.gate].call calls authorize, which auth/Gate does not export",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "auth-call.toml", "MockDoorCaller"],
        "[mock.auth.gate].call calls authorize, which auth/Gate does not export",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "auth-returns.toml"],
        "[mock.auth.pass].call: authenticate returns Ticket, not Badge",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "caller-type.toml"],
        "[mock].caller_type: who/Who declares no struct or new type Account",
    ),
    row(
        "authenticators",
        &["generate", "--config", "inject-call.toml"],
        "[mock.inject.blinding].call calls peek, which random/Blind does not export",
    ),
    row(
        "authenticators",
        &["generate", "--config", "inject-returns.toml"],
        "[mock.inject.blinding].call: zero returns Bytes<32>, not Blinding",
    ),
    row(
        "authenticators",
        &["generate", "--config", "inject-type.toml"],
        "[mock.inject.raw].type: random/Blind declares no struct, enum or new type Raw",
    ),
    // plan
    row(
        "rules",
        &["generate", "--config", "rename-errors.toml"],
        "MockCalcA: rename target double clashes with circuit double",
    ),
    row(
        "rules",
        &["generate", "--config", "disclose-errors.toml"],
        "MockSum: disclose names clear, which returns []",
    ),
    row(
        "generics",
        &["generate", "--config", "circuit-generics-errors.toml"],
        "MockPick: circuit keep has type parameters <#k>; set circuit_args.keep or add it to exclude",
    ),
    row(
        "generics",
        &["generate", "--config", "module-generics-errors.toml"],
        "MockBag: circuit initialize has type parameters <#k> and the constructor calls it; set circuit_args.initialize",
    ),
    row(
        "rules",
        &["generate", "--config", "init-overload.toml"],
        "MockReset: calc/Reset exports 2 circuits named initialize, and overloads are not supported; set init = \"none\" and add initialize to exclude or write the mock by hand",
    ),
    row(
        "rules",
        &["generate", "--config", "guard-shadow.toml"],
        "MockDial: guarded circuit spin has a parameter named _invocations, which hides the guard counter; leave spin unguarded",
    ),
    row(
        "generics",
        &["generate", "--config", "circuit-generics-errors.toml"],
        "MockPick: circuit_args.choose has 2 arguments; choose takes 1",
    ),
    row(
        "generics",
        &["generate", "--config", "circuit-generics-errors.toml"],
        "MockPick: circuit_args.hold: hold has no type parameters",
    ),
    row(
        "generics",
        &["generate", "--config", "module-generics-errors.toml"],
        "MockBag: module_args has 1 arguments; bag/Bag takes 2",
    ),
    row(
        "rules",
        &["generate", "--config", "init-errors.toml"],
        "MockCalc: init flag start clashes with a constructor parameter",
    ),
    row(
        "diagnostics",
        &["generate", "--config", "pattern.toml"],
        "MockPattern: parameter 1 of sum is a pattern; a wrapper needs a named parameter",
    ),
    row(
        "types",
        &["generate", "--config", "prefixed-types-errors.toml"],
        "MockShapeHidden: sketch uses Draft, which shape/Shape does not export; the wrapper cannot name it",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "salt-errors.toml"],
        "MockConfidentialFungibleTokenRegister: salt \"MockConfidentialFungibleTokenRegister\" is 37 bytes; pad(32, ...) takes at most 32. Set salt",
    ),
    row(
        "authenticators",
        &["generate", "--config", "salt-ledger-missing.toml"],
        "MockVault: salt ledger field _missing is not an exported ledger field of access/Vault",
    ),
    row(
        "generics",
        &["generate", "--config", "module-generics-missing.toml"],
        "MockBag: bag/Bag takes 2 generic arguments; set module_args or instances",
    ),
    row(
        "overload",
        &["generate", "--config", "rename-missing.toml"],
        "MockDial: rename key \"turn(Field)\" matches no overload of turn",
    ),
    row(
        "instances",
        &["generate", "--config", "same-args.toml"],
        "MockUintN: instances A and B pass the same module arguments < 2 >; compactc would share one instance of math/UintN",
    ),
    row(
        "instances",
        &["generate", "--config", "ctor-clash.toml"],
        "MockMultisig: constructor parameter signerCommitments has type Vector<3, Bytes<32>> in instance 2 and Vector<2, Bytes<32>> in instance 3",
    ),
    row(
        "witness-clash",
        &["generate"],
        "MockBoth: witness secret is declared by both src/lib/Left.compact and src/lib/Right.compact; compactc binds both to one witness function. Remove one import or write the mock by hand",
    ),
    row(
        "implements",
        &["generate", "--config", "implements-none.toml"],
        "MockCount: implements Nope, but iface/Iface declares no exported contract Nope",
    ),
    row(
        "implements",
        &["generate", "--config", "implements-missing.toml"],
        "MockCount: implements Tally, but exposes no circuit reset; add it to src/count/test/MockCount.fragment.compact",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "salt-errors.toml"],
        "MockHingeEmpty: salt must be non-empty and must not contain \", \\ or a control character",
    ),
    row(
        "rules",
        &["generate", "--config", "include-errors.toml"],
        "MockSwitch: fragment src/calc/test/MockSwitch.fragment.compact does not exist",
    ),
    row(
        "rules",
        &["generate", "--config", "include-errors.toml"],
        "MockCalcFragment: fragment src/calc/test/MockCalcFragment.fragment.compact declares a constructor; set init = \"none\"",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "unresolved.toml"],
        "MockLost: parameter caller of enter has type Ghost, which does not resolve; with caller_type set, every parameter type must resolve",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "contains-caller.toml"],
        "MockLatch: parameter who of hold has type Maybe<Badge>, which contains Badge but is not it; add hold to exclude",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "contains-caller.toml"],
        "MockCrate: parameter parcel of ship has type Parcel, which contains Badge but is not it; add ship to exclude",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "contains-caller.toml"],
        "MockCrate: parameter first of initialize has type Parcel, which contains Badge but is not it; set init = \"none\" and add initialize to exclude",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "caller-twice.toml"],
        "MockPair: swap takes 2 Badge parameters, and the authenticated mock would pass one caller to all of them; add swap to exclude, or use the caller mock",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "caller-twice.toml"],
        "MockPair: initialize takes 2 Badge parameters, and the authenticated mock would pass one caller to all of them; set init = \"none\" and add initialize to exclude, or use the caller mock",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "caller-argument.toml"],
        "MockShelf: circuit_args.stack sets a type parameter to Maybe<Badge>, which is or contains Badge, so the mock could take a caller it does not authenticate; add stack to exclude",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "caller-argument.toml"],
        "MockShelf: circuit_args.initialize sets a type parameter to Badge, which is or contains Badge, so the mock could take a caller it does not authenticate; set init = \"none\" and add initialize to exclude",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "caller-argument.toml"],
        "MockBin: module_args sets a type parameter to Badge, which is or contains Badge, so the mock could take a caller it does not authenticate; write the mock by hand",
    ),
    row(
        "auth-layer",
        &["generate", "--config", "prefix-collision.toml"],
        "MockDoor: prefix Who_ is used by two imports (\"../../../who/Who\" and \"../../Door\")",
    ),
    // output
    Row {
        case: Some("ownership"),
        setup: Some(unstamped),
        args: &["generate"],
        code: EXIT_ERROR,
        closed_stdout: false,
        message: "src/lib/test/artifacts exists and has no .compact-mock-stamp; compact-mock writes only into directories it owns. Move it away or empty it",
    },
    Row {
        case: Some("rebase"),
        setup: Some(directory_at_target),
        args: &["generate"],
        code: EXIT_ERROR,
        closed_stdout: false,
        message: "cannot read src/near/test/artifacts/MockNear.compact",
    },
    Row {
        case: Some("diagnostics"),
        setup: None,
        args: &["generate", "--config", "ok.toml"],
        code: EXIT_ERROR,
        closed_stdout: true,
        message: "cannot write to stdout",
    },
    // build
    row(
        "toolchain",
        &["build", "MockAlpha", "--compact-bin", "./no/compact"],
        "cannot run ./no/compact; install the Compact toolchain or pass --compact-bin",
    ),
    exits(
        "toolchain",
        &["build", "MockAlpha", "--compact-bin", "false"],
        EXIT_COMPILE,
        "compact compile failed for src/lib/test/artifacts/MockAlpha.compact (exit 1)",
    ),
    row(
        "toolchain",
        &["build", "+0.36.0", "+0.35.0"],
        "build takes at most one +<VERSION>",
    ),
    // info and summary
    exits(
        "globs",
        &["generate"],
        0,
        "skipped presets/Preset: not a module",
    ),
    exits(
        "globs",
        &["generate"],
        0,
        "skipped who/Who: no exported circuits",
    ),
    row(
        "rules",
        &["generate", "--config", "errors-batch.toml"],
        "5 errors; nothing written.",
    ),
];

#[test]
fn every_diagnostic_prints_its_exact_text_and_exit_code() {
    let found = failures(ROWS);
    assert!(found.is_empty(), "{}", found.join("\n"));
}

#[test]
fn a_rename_clash_names_the_entity_it_clashes_with() {
    let rows = [
        row(
            "rules",
            &["generate", "--config", "rename-errors.toml"],
            "MockCalcB: rename target Calc__total clashes with ledger field Calc__total",
        ),
        row(
            "rules",
            &["generate", "--config", "rename-errors.toml"],
            "MockCalcC: rename target _invocations clashes with ledger _invocations",
        ),
        row(
            "types",
            &["generate", "--config", "prefixed-types-errors.toml"],
            "MockShapeType: rename target Point clashes with type Point",
        ),
    ];
    let found = failures(&rows);
    assert!(found.is_empty(), "{}", found.join("\n"));
}

#[test]
fn a_rename_onto_an_imported_name_is_an_error() {
    let rows = [row(
        "auth-layer",
        &["generate", "--config", "rename-import.toml"],
        "MockDoor: rename target Account clashes with import Account",
    )];
    let found = failures(&rows);
    assert!(found.is_empty(), "{}", found.join("\n"));
}

#[cfg(unix)]
#[test]
fn a_write_under_a_dangling_link_is_reported() {
    let rows = [Row {
        case: Some("rebase"),
        setup: Some(|root| {
            std::os::unix::fs::symlink(root.join("nowhere"), root.join("src/far/test"))
                .expect("a dangling link blocks the directory");
        }),
        args: &["generate"],
        code: EXIT_ERROR,
        closed_stdout: false,
        message: "cannot write src/far/test/artifacts/.compact-mock-stamp",
    }];
    let found = failures(&rows);
    assert!(found.is_empty(), "{}", found.join("\n"));
}

#[cfg(unix)]
#[test]
fn a_stale_entry_that_cannot_be_removed_is_reported() {
    use std::os::unix::fs::PermissionsExt;

    let row = Row {
        case: Some("ownership"),
        setup: None,
        args: &["generate"],
        code: EXIT_ERROR,
        closed_stdout: false,
        message: "cannot remove src/lib/test/artifacts/MockGone",
    };
    let directory = prepare(&row);
    let locked = directory
        .path()
        .join("src/lib/test/artifacts/MockGone/contract");
    let mode = |bits| std::fs::Permissions::from_mode(bits);
    std::fs::set_permissions(&locked, mode(0o555)).expect("the directory is locked");
    // A process that ignores directory permissions cannot reach this message.
    let enforced = std::fs::write(locked.join("probe"), "").is_err();
    let outcome = enforced.then(|| run_in(directory.path(), &row));
    std::fs::set_permissions(&locked, mode(0o755)).expect("the directory is unlocked");
    let Some((code, stderr)) = outcome else {
        return;
    };
    let line = format!("compact-mock: {}", row.message);
    assert_eq!(code, EXIT_ERROR, "{stderr}");
    assert!(stderr.lines().any(|printed| printed == line), "{stderr}");
}

#[test]
fn a_cause_line_follows_each_io_toml_and_glob_error() {
    for args in [
        &["generate", "--config", "missing.toml"][..],
        &["generate", "--config", "bad-syntax.toml"][..],
        &["generate", "--config", "unreadable.toml"][..],
        &["generate", "--config", "bad-glob.toml"][..],
    ] {
        let (_, stderr) = run(&row("diagnostics", args, ""));
        let mut lines = stderr.lines();
        assert!(
            lines
                .next()
                .is_some_and(|line| line.starts_with("compact-mock: ")),
            "{stderr}"
        );
        assert!(
            lines
                .next()
                .is_some_and(|line| line.starts_with("  caused by: ")),
            "{stderr}"
        );
    }
}

#[test]
fn a_pattern_parameter_needs_a_name_only_in_a_wrapper() {
    let (code, stderr) = run(&row(
        "diagnostics",
        &["generate", "--config", "pattern-reexport.toml"],
        "",
    ));
    assert_eq!(code, 0, "{stderr}");
}

#[test]
fn usage_errors_exit_two_and_help_and_version_exit_zero() {
    let directory = TempDir::new().expect("a temporary directory");
    let code = |args: &[&str]| {
        Command::cargo_bin("compact-mock")
            .expect("the binary is built")
            .current_dir(directory.path())
            .args(args)
            .output()
            .expect("the binary ran")
            .status
            .code()
            .expect("not signalled")
    };
    assert_eq!(code(&[]), EXIT_ERROR);
    assert_eq!(code(&["mock"]), EXIT_ERROR);
    assert_eq!(code(&["generate", "--check"]), EXIT_ERROR);
    assert_eq!(code(&["build", "--force"]), EXIT_ERROR);
    assert_eq!(code(&["--version"]), 0);
    assert_eq!(code(&["--help"]), 0);
    assert_eq!(code(&["generate", "--help"]), 0);
    assert_eq!(code(&["build", "--help"]), 0);
}
