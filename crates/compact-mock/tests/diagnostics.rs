//! Every diagnostic the generator prints, each produced by a real run and matched by its
//! exact text.
//!
//! A row names a fixture case, an optional edit to the copied tree, the arguments, and
//! one line the run must print to stderr. The cause lines that follow some messages carry
//! OS or TOML text and are not compared.

use std::path::{Path, PathBuf};
use std::process::Command;

use assert_cmd::prelude::*;
use compact_mock::error::ConfigError;
use tempfile::TempDir;

/// Exit code for a usage, config, IO, parse or planning error.
const EXIT_ERROR: i32 = 2;

/// Stands for the temporary directory in a message.
const ROOT: &str = "<root>";

struct Row {
    /// The fixture case to copy, or `None` for an empty directory.
    case: Option<&'static str>,
    /// An edit to the copied tree before the run.
    setup: Option<fn(&Path)>,
    args: &'static [&'static str],
    /// One stderr line, without the `compact-mock: ` prefix.
    message: &'static str,
}

const fn row(case: &'static str, args: &'static [&'static str], message: &'static str) -> Row {
    Row {
        case: Some(case),
        setup: None,
        args,
        message,
    }
}

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// Copies `from` into `to`, leaving out the expectations.
fn copy(from: &Path, to: &Path) {
    for entry in std::fs::read_dir(from).expect("the case is readable") {
        let path = entry.expect("the entry is readable").path();
        let name = path.file_name().expect("a file name").to_owned();
        if name == "expected" {
            continue;
        }
        let target = to.join(&name);
        if path.is_dir() {
            std::fs::create_dir_all(&target).expect("dirs are created");
            copy(&path, &target);
        } else {
            std::fs::copy(&path, &target).expect("the input is copied");
        }
    }
}

/// Runs a row and returns its exit code and stderr, with the directory shown as [`ROOT`].
fn run(row: &Row) -> (i32, String) {
    let directory = TempDir::new().expect("a temporary directory");
    if let Some(case) = row.case {
        copy(&fixtures().join(case), directory.path());
    }
    if let Some(setup) = row.setup {
        setup(directory.path());
    }
    let output = Command::cargo_bin("compact-mock")
        .expect("the binary is built alongside this test")
        .current_dir(directory.path())
        .arg("generate")
        .args(row.args)
        .output()
        .expect("the binary ran");
    let root = directory
        .path()
        .canonicalize()
        .expect("the directory exists")
        .display()
        .to_string();
    let stderr = String::from_utf8(output.stderr)
        .expect("stderr is UTF-8")
        .replace(&root, ROOT);
    (output.status.code().expect("not signalled"), stderr)
}

const ROWS: &[Row] = &[
    // config
    Row {
        case: None,
        setup: None,
        args: &[],
        message: "no compact-mock.toml in <root> or any parent; pass --config <FILE>",
    },
    row(
        "diagnostics",
        &["--config", "missing.toml"],
        "cannot read config missing.toml",
    ),
    row(
        "diagnostics",
        &["--config", "bad-key.toml"],
        "cannot parse config bad-key.toml",
    ),
    row(
        "diagnostics",
        &["--config", "bad-shape.toml"],
        "cannot parse config bad-shape.toml",
    ),
    row(
        "diagnostics",
        &["--config", "no-entries.toml"],
        "config no-entries.toml has no [[mock]] entry",
    ),
    row(
        "diagnostics",
        &["--config", "bad-module.toml"],
        "config bad-module.toml: module \"ok/Ok.compact\" is a path relative to src, without .compact",
    ),
    row(
        "diagnostics",
        &["--config", "src-missing.toml"],
        "config src-missing.toml: src directory sources does not exist",
    ),
    row(
        "diagnostics",
        &["--config", "bad-name.toml"],
        "config bad-name.toml: ok/Ok: name \"1st\" is not an identifier",
    ),
    row(
        "diagnostics",
        &["--config", "derived-name.toml"],
        "config derived-name.toml: bad/my-module: name \"Mockmy-module\" is not an identifier",
    ),
    row(
        "diagnostics",
        &["--config", "needs-auth.toml"],
        "config needs-auth.toml: ok/Ok: salt needs an [auth] table",
    ),
    row(
        "auth-layer",
        &["--config", "variant-keys.toml"],
        "config variant-keys.toml: door/Door: variants must be a non-empty subset of [\"auth\", \"caller\"]",
    ),
    row(
        "auth-layer",
        &["--config", "variant-keys.toml"],
        "config variant-keys.toml: door/Door: salt applies to the authenticated variant only",
    ),
    row(
        "rules",
        &["--config", "include-errors.toml"],
        "config include-errors.toml: MockCalcC: include \"Calc.extra\" must end in .fragment.compact",
    ),
    row(
        "auth-layer",
        &["--config", "salt-placeholder.toml"],
        "config salt-placeholder.toml: [auth].call must contain {salt} exactly once, inside a \"...\" string",
    ),
    row(
        "rebase",
        &["--config", "parent-at-root.toml"],
        "config parent-at-root.toml: MockRoot: out_dir uses {parent}, but Root sits at the root of src",
    ),
    row(
        "diagnostics",
        &["--config", "placeholder.toml"],
        "config placeholder.toml: out_dir \"{dir}/{name}\" has an unknown placeholder {name}",
    ),
    row(
        "diagnostics",
        &["--config", "spdx.toml"],
        "config spdx.toml: spdx must be a single line",
    ),
    row(
        "diagnostics",
        &["--config", "duplicate-name.toml"],
        "config duplicate-name.toml: two mocks are named Mockok",
    ),
    row(
        "auth-layer",
        &["--config", "expansion.toml", "MockNope"],
        "no mock named MockNope in expansion.toml",
    ),
    // source
    row(
        "diagnostics",
        &["--config", "unreadable.toml"],
        "cannot read src/bad/Binary.compact",
    ),
    row(
        "rules",
        &["--config", "errors-batch.toml"],
        "cannot read src/calc/Gone.compact",
    ),
    row(
        "diagnostics",
        &["--config", "broken.toml"],
        "src/bad/Broken.compact:7:10: parse error",
    ),
    row(
        "rules",
        &["--config", "include-errors.toml"],
        "src/calc/test/mocks/Broken.fragment.compact:4:1: parse error",
    ),
    row(
        "diagnostics",
        &["--config", "twice.toml"],
        "src/bad/Twice.compact: expected one module declaration, found 2",
    ),
    row(
        "diagnostics",
        &["--config", "no-pragma.toml"],
        "src/bad/NoPragma.compact: no pragma to copy into the mock",
    ),
    row(
        "auth-layer",
        &["--config", "lost-without-auth.toml"],
        "src/door/Lost.compact: import \"../gone/Gone\" does not resolve to src/gone/Gone.compact",
    ),
    // auth
    row(
        "auth-layer",
        &["--config", "auth-call.toml"],
        "[auth].call calls authorize, which auth/Gate does not export",
    ),
    row(
        "auth-layer",
        &["--config", "auth-call.toml", "MockDoorCaller"],
        "[auth].call calls authorize, which auth/Gate does not export",
    ),
    row(
        "auth-layer",
        &["--config", "caller-type.toml"],
        "[auth].caller_type: who/Who declares no struct Account",
    ),
    // plan
    row(
        "auth-layer",
        &["--config", "no-caller-param.toml"],
        "MockTwin: door/Twin has no Badge parameter, so salt does not apply",
    ),
    row(
        "rules",
        &["--config", "disclose-errors.toml"],
        "MockCalc: disclose names nope, which calc/Calc does not export as a circuit",
    ),
    row(
        "rules",
        &["--config", "rename-errors.toml"],
        "MockCalcD: rename names reset, which MockCalcD does not expose",
    ),
    row(
        "rules",
        &["--config", "init-errors.toml"],
        "MockCalcGuarded: guard names initialize, which MockCalcGuarded does not expose",
    ),
    row(
        "rules",
        &["--config", "rename-errors.toml"],
        "MockCalcA: rename target double clashes with circuit double",
    ),
    row(
        "types",
        &["--config", "prefixed-types-errors.toml"],
        "MockShapeType: rename target Point clashes with type Point",
    ),
    row(
        "rules",
        &["--config", "rename-errors.toml"],
        "MockCalcB: rename target Calc__total clashes with ledger field Calc__total",
    ),
    row(
        "auth-layer",
        &["--config", "rename-import.toml"],
        "MockDoor: rename target Account clashes with import Account",
    ),
    row(
        "rules",
        &["--config", "rename-errors.toml"],
        "MockCalcC: rename target _invocations clashes with ledger _invocations",
    ),
    row(
        "rules",
        &["--config", "disclose-errors.toml"],
        "MockSum: disclose names clear, which returns []",
    ),
    row(
        "generics",
        &["--config", "circuit-generics-errors.toml"],
        "MockPick: circuit keep has type parameters <#k>; set circuit_args.keep or add it to exclude",
    ),
    row(
        "generics",
        &["--config", "circuit-generics-errors.toml"],
        "MockPick: circuit_args.choose has 2 arguments; choose takes 1",
    ),
    row(
        "generics",
        &["--config", "circuit-generics-errors.toml"],
        "MockPick: circuit_args.hold: hold has no type parameters",
    ),
    row(
        "generics",
        &["--config", "module-generics-errors.toml"],
        "MockBag: module_args has 1 arguments; bag/Bag takes 2",
    ),
    row(
        "rules",
        &["--config", "init-errors.toml"],
        "MockSum: init = \"plain\" needs an exported initialize circuit in calc/Sum",
    ),
    row(
        "rules",
        &["--config", "init-errors.toml"],
        "MockSumFlag: init = { flag = \"ready\" } needs an exported initialize circuit in calc/Sum",
    ),
    row(
        "rules",
        &["--config", "init-errors.toml"],
        "MockCalc: init flag start clashes with an initialize parameter",
    ),
    row(
        "diagnostics",
        &["--config", "pattern.toml"],
        "MockPattern: parameter 1 of sum is a pattern; a wrapper needs a named parameter",
    ),
    row(
        "types",
        &["--config", "prefixed-types-errors.toml"],
        "MockShapeHidden: sketch uses Draft, which shape/Shape does not export; the wrapper cannot name it",
    ),
    row(
        "types",
        &["--config", "export-list-errors.toml"],
        "MockRegistry: isMember is re-exported by reg/Registry's export list and needs a wrapper; add it to exclude",
    ),
    row(
        "auth-layer",
        &["--config", "salt-errors.toml"],
        "MockConfidentialFungibleTokenRegister: salt \"MockConfidentialFungibleTokenRegister\" is 37 bytes; pad(32, ...) takes at most 32. Set salt",
    ),
    row(
        "auth-layer",
        &["--config", "salt-errors.toml"],
        "MockHingeEmpty: salt must be non-empty and must not contain \", \\ or a control character",
    ),
    row(
        "rules",
        &["--config", "include-errors.toml"],
        "MockCalcA: fragment src/calc/test/mocks/MockCalcA.fragment.compact does not exist",
    ),
    row(
        "rules",
        &["--config", "include-errors.toml"],
        "MockCalc: fragment src/calc/test/mocks/MockCalc.fragment.compact declares a constructor; set init = \"none\"",
    ),
    row(
        "auth-layer",
        &["--config", "unresolved.toml"],
        "MockLost: parameter caller of enter has type Ghost, which does not resolve; with [auth] set, every parameter type must resolve",
    ),
    row(
        "auth-layer",
        &["--config", "contains-caller.toml"],
        "MockLatch: parameter who of hold has type Maybe<Badge>, which contains Badge but is not it; add hold to exclude",
    ),
    row(
        "auth-layer",
        &["--config", "prefix-collision.toml"],
        "MockDoor: prefix Who_ is used by two imports (\"../../../who/Who\" and \"../../Door\")",
    ),
    // output
    row(
        "unmarked-file",
        &[],
        "src/lib/test/mocks/MockTally.compact exists without the compact-mock marker; move or delete it to let compact-mock own it",
    ),
    Row {
        case: Some("rules"),
        setup: Some(|root| {
            std::fs::create_dir_all(root.join("src/calc/test/mocks/MockCalc.compact"))
                .expect("a directory sits at the target path");
        }),
        args: &["--config", "disclose.toml"],
        message: "cannot read src/calc/test/mocks/MockCalc.compact",
    },
    Row {
        case: Some("rebase"),
        setup: Some(|root| {
            std::fs::write(root.join("src/far/test"), "a file where a directory goes")
                .expect("the blocker is written");
        }),
        args: &[],
        message: "cannot write src/far/test/mocks/MockFar.compact",
    },
    // summary
    row(
        "rules",
        &["--config", "errors-batch.toml"],
        "5 errors; nothing written.",
    ),
];

#[test]
fn every_diagnostic_prints_its_exact_text_and_exits_two() {
    let mut failures = Vec::new();
    for row in ROWS {
        let (code, stderr) = run(row);
        let line = format!("compact-mock: {}", row.message);
        if code != EXIT_ERROR || !stderr.lines().any(|printed| printed == line) {
            failures.push(format!(
                "{:?} {:?}: exit {code}, expected line\n  {line}\nstderr:\n{stderr}",
                row.case, row.args
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_cause_line_follows_each_io_and_toml_error() {
    for args in [
        &["--config", "missing.toml"][..],
        &["--config", "bad-key.toml"][..],
        &["--config", "unreadable.toml"][..],
    ] {
        let (_, stderr) = run(&row("diagnostics", args, ""));
        let mut lines = stderr.lines();
        assert!(
            lines
                .next()
                .is_some_and(|line| line.starts_with("compact-mock: "))
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
        &["--config", "pattern-reexport.toml"],
        "",
    ));
    assert_eq!(code, 0, "{stderr}");
}

#[test]
fn the_duplicate_path_message_names_both_mocks_and_the_path() {
    // Mock names are identifiers and each path ends in `<name>.compact`, so two distinct
    // names never share a path and no config reaches this message.
    let error = ConfigError::DuplicatePath {
        cfg: "compact-mock.toml".to_owned(),
        mock: "MockA".to_owned(),
        other: "MockB".to_owned(),
        path: "src/test/mocks/MockA.compact".to_owned(),
    };
    assert_eq!(
        error.to_string(),
        "config compact-mock.toml: MockA and MockB both write src/test/mocks/MockA.compact"
    );
}

#[test]
fn usage_errors_exit_two_and_help_and_version_exit_zero() {
    let directory = TempDir::new().expect("a temporary directory");
    let code = |args: &[&str]| {
        Command::cargo_bin("compact-mock")
            .expect("the binary is built alongside this test")
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
    assert_eq!(code(&["generate", "--force"]), EXIT_ERROR);
    assert_eq!(code(&["--version"]), 0);
    assert_eq!(code(&["--help"]), 0);
    assert_eq!(code(&["generate", "--help"]), 0);
}
