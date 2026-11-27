//! `compact-lint check` with the `mock-coverage` rule, which reads `[mock]` through the
//! `compact-mock` crate.

use std::path::{Path, PathBuf};
use std::process::Command;

use assert_cmd::prelude::*;

/// Exit code for a usage, config, IO or parser error.
const EXIT_ERROR: i32 = 2;

fn case() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/mock-coverage")
        .canonicalize()
        .expect("the fixture case exists")
}

/// Runs `check` in `cwd` and returns the exit code, stdout and stderr.
fn run(cwd: &Path, extra: &[&str]) -> (i32, String, String) {
    let output = Command::cargo_bin("compact-lint")
        .expect("the binary is built alongside this test")
        .current_dir(cwd)
        .args([
            "check",
            "--no-format",
            "--colors=off",
            "--reporter",
            "concise",
        ])
        .args(extra)
        .output()
        .expect("the binary ran");
    (
        output.status.code().expect("the binary was not signalled"),
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
        String::from_utf8(output.stderr).expect("the summary is UTF-8"),
    )
}

fn findings(stdout: &str) -> Vec<&str> {
    stdout
        .lines()
        .filter(|line| line.contains(": mock-coverage: "))
        .collect()
}

/// Every file under `root` with its bytes, to prove a run writes nothing.
fn snapshot(root: &Path) -> Vec<(PathBuf, Vec<u8>)> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).expect("the directory is readable") {
            let path = entry.expect("the entry is readable").path();
            if path.is_dir() {
                pending.push(path);
            } else {
                let bytes = std::fs::read(&path).expect("the file is readable");
                found.push((path, bytes));
            }
        }
    }
    found.sort();
    found
}

#[test]
fn unmatched_modules_uncovered_circuits_and_plan_failures_are_reported_at_their_names() {
    let before = snapshot(&case());
    let (code, stdout, _) = run(&case(), &[]);
    assert_eq!(code, 0, "warnings only");
    assert_eq!(
        findings(&stdout),
        [
            "! src/a/Partial.compact:5:18: mock-coverage: circuit close is exposed by no generated mock of a/Partial (MockPartial)",
            "! src/b/Loose.compact:3:8: mock-coverage: module b/Loose has no generated mock; add it to a [[mock.rules]] glob, or to [mock].exclude if its mock stays hand-written",
            "! src/d/Broken.compact:3:8: mock-coverage: compact-mock cannot plan the mocks of d/Broken: MockBroken: d/Broken exports 2 circuits named initialize, and overloads are not supported; set init = \"none\" and add initialize to exclude or write the mock by hand",
        ]
    );
    assert_eq!(snapshot(&case()), before, "the rule writes nothing");
}

#[test]
fn a_path_argument_from_a_subdirectory_limits_the_findings_to_its_files() {
    let (code, stdout, _) = run(&case().join("src"), &["b"]);
    assert_eq!(code, 0);
    assert_eq!(
        findings(&stdout),
        [
            "! b/Loose.compact:3:8: mock-coverage: module b/Loose has no generated mock; add it to a [[mock.rules]] glob, or to [mock].exclude if its mock stays hand-written"
        ]
    );
}

#[test]
fn the_rule_is_silent_when_off_or_without_a_mock_table() {
    for config in ["off.toml", "no-mock.toml"] {
        let (code, stdout, _) = run(&case(), &["--config", config]);
        assert_eq!(code, 0, "{config}");
        assert!(findings(&stdout).is_empty(), "{config}: {stdout}");
    }
}

#[test]
fn a_level_of_error_fails_the_run() {
    let (code, stdout, _) = run(&case(), &["--config", "error.toml"]);
    assert_eq!(code, 1, "{stdout}");
    assert_eq!(findings(&stdout).len(), 3);
}

#[test]
fn a_broken_mock_table_fails_the_run_with_its_errors_as_causes() {
    let (code, _, stderr) = run(&case(), &["--config", "broken.toml"]);
    assert_eq!(code, EXIT_ERROR);
    let lines: Vec<&str> = stderr.lines().collect();
    assert_eq!(
        lines[1],
        "  caused by: cannot load the [mock] table of broken.toml"
    );
    assert!(
        lines[2].ends_with("broken.toml: [[mock.rules]] #1: unknown key bogus; not a rule key or an authenticator name"),
        "{stderr}"
    );
}
