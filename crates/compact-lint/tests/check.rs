//! `compact-lint check` end to end, one fixture case per rule.
//!
//! Every case runs with `--no-format`, because CI has no `compact` binary.

use std::path::PathBuf;
use std::process::Command;

use assert_cmd::prelude::*;

/// Exit code for a run that produced findings.
const EXIT_FINDINGS: i32 = 1;

/// Exit code for a usage, config, IO or parser error.
const EXIT_ERROR: i32 = 2;

fn case(name: &str) -> PathBuf {
    // The child reports its working directory resolved, so the expectation must be too.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
        .canonicalize()
        .expect("the fixture case exists")
}

fn binary() -> Command {
    Command::cargo_bin("compact-lint").expect("the binary is built alongside this test")
}

fn expected(name: &str) -> String {
    std::fs::read_to_string(case(name).join("expected.txt")).expect("the case has an expectation")
}

/// Runs `check` inside a case directory and returns its exit code and stdout.
fn run(name: &str, extra: &[&str]) -> (i32, String) {
    let output = binary()
        .current_dir(case(name))
        .args(["check", "--no-format"])
        .args(extra)
        .output()
        .expect("the binary ran");

    (
        output.status.code().expect("the binary was not signalled"),
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
    )
}

fn assert_case(name: &str, extra: &[&str], code: i32) {
    let (actual_code, stdout) = run(name, extra);

    assert_eq!(stdout, expected(name), "stdout for case {name}");
    assert_eq!(actual_code, code, "exit code for case {name}");
}

#[test]
fn a_fully_documented_module_reports_nothing() {
    assert_case("clean", &[], 0);
}

#[test]
fn undocumented_declarations_and_detached_docs_report_missing_doc() {
    assert_case("missing-doc", &[], EXIT_FINDINGS);
}

#[test]
fn a_doc_comment_without_a_required_tag_reports_missing_tag() {
    assert_case("missing-tag", &[], EXIT_FINDINGS);
}

#[test]
fn a_forbidden_tag_reports_wherever_it_appears() {
    assert_case("forbidden-tag", &[], EXIT_FINDINGS);
}

#[test]
fn a_module_tag_naming_another_module_reports_module_name() {
    assert_case("module-name", &[], EXIT_FINDINGS);
}

#[test]
fn an_unannotated_exported_circuit_reports_missing_constraints() {
    assert_case("missing-constraints", &[], EXIT_FINDINGS);
}

#[test]
fn a_malformed_constraints_value_reports_constraints_format() {
    assert_case("constraints-format", &[], EXIT_FINDINGS);
}

#[test]
fn a_placeholder_reports_only_under_strict() {
    let (code, stdout) = run("constraints-placeholder", &[]);
    assert_eq!(stdout, "");
    assert_eq!(code, 0);

    assert_case("constraints-placeholder", &["--strict"], EXIT_FINDINGS);
}

#[test]
fn a_broken_file_reports_parse_instead_of_crashing() {
    assert_case("parse", &[], EXIT_FINDINGS);
}

#[test]
fn an_explicit_path_replaces_the_include_globs() {
    let output = binary()
        .current_dir(case("missing-doc"))
        .args(["check", "--no-format", "Gaps.compact"])
        .output()
        .expect("the binary ran");

    assert_eq!(
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
        expected("missing-doc")
    );
}

#[test]
fn an_exclude_glob_applies_to_an_explicit_path_given_from_a_subdirectory() {
    let output = binary()
        .current_dir(case("exclude-explicit-dir").join("contracts"))
        .args(["check", "--no-format", "live", "archive"])
        .output()
        .expect("the binary ran");

    assert_eq!(
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
        expected("exclude-explicit-dir")
    );
    assert_eq!(output.status.code(), Some(EXIT_FINDINGS));
}

#[test]
fn an_explicit_config_anchors_discovery_at_the_working_directory() {
    let config = case("clean").join("compact-lint.toml");
    let output = binary()
        .current_dir(case("missing-doc"))
        .args(["check", "--no-format", "--config"])
        .arg(&config)
        .output()
        .expect("the binary ran");

    assert_eq!(
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
        expected("missing-doc")
    );
}

#[test]
fn a_missing_compact_binary_exits_two_and_names_the_escape_hatch() {
    let output = binary()
        .current_dir(case("clean"))
        .args(["check", "--compact-bin", "compact-lint-no-such-binary"])
        .output()
        .expect("the binary ran");

    let stderr = String::from_utf8(output.stderr).expect("the error is UTF-8");
    assert_eq!(output.status.code(), Some(EXIT_ERROR), "{stderr}");
    assert!(stderr.contains("--no-format"), "{stderr}");
}

#[test]
fn an_unreadable_config_exits_two() {
    let output = binary()
        .current_dir(case("clean"))
        .args(["check", "--no-format", "--config", "compact-lint.toml.nope"])
        .output()
        .expect("the binary ran");

    assert_eq!(output.status.code(), Some(EXIT_ERROR));
}

#[test]
fn the_summary_goes_to_stderr_and_the_findings_to_stdout() {
    let output = binary()
        .current_dir(case("module-name"))
        .args(["check", "--no-format"])
        .output()
        .expect("the binary ran");

    let stderr = String::from_utf8(output.stderr).expect("the summary is UTF-8");
    assert_eq!(stderr.trim_end(), "1 findings in 1 files");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("module-name"),
        "the rule id belongs on stdout"
    );
}
