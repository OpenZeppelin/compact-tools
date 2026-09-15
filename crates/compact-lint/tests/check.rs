//! `compact-lint check` end to end, one fixture case per rule.
//!
//! Every case runs with `--no-format`, because CI has no `compact` binary, and with
//! `--colors=off`, so the expectation holds whatever the runner's terminal is.

use std::fmt::Write as _;
use std::path::PathBuf;
use std::process::Command;

use assert_cmd::prelude::*;

/// Exit code for a run that produced errors.
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

fn expected(name: &str, file: &str) -> String {
    std::fs::read_to_string(case(name).join(file)).expect("the case has an expectation")
}

/// Runs `check` inside a case directory and returns its exit code, stdout and stderr.
fn run(name: &str, extra: &[&str]) -> (i32, String, String) {
    let output = binary()
        .current_dir(case(name))
        .args(["check", "--no-format", "--colors=off"])
        .args(extra)
        .output()
        .expect("the binary ran");

    (
        output.status.code().expect("the binary was not signalled"),
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
        String::from_utf8(output.stderr).expect("the summary is UTF-8"),
    )
}

/// Replaces the measured duration, the one part of the summary a run cannot repeat.
fn without_duration(stderr: &str) -> String {
    let mut out = String::new();
    for line in stderr.lines() {
        match line
            .split_once(" in ")
            .filter(|_| line.starts_with("Checked "))
        {
            Some((head, tail)) => match tail.split_once(". ") {
                Some((_, rest)) => {
                    let _ = write!(out, "{head} in <duration>. {rest}");
                }
                None => out.push_str(line),
            },
            None => out.push_str(line),
        }
        out.push('\n');
    }
    out
}

fn assert_case(name: &str, extra: &[&str], code: i32) {
    assert_expectation(name, "expected.txt", extra, code);
}

fn assert_expectation(name: &str, file: &str, extra: &[&str], code: i32) {
    let (actual_code, stdout, _) = run(name, extra);

    assert_eq!(stdout, expected(name, file), "stdout for case {name}");
    assert_eq!(actual_code, code, "exit code for case {name}");
}

#[test]
fn a_fully_documented_module_reports_nothing() {
    assert_case("clean", &[], 0);

    let (_, _, stderr) = run("clean", &[]);
    assert_eq!(
        without_duration(&stderr),
        "Checked 1 file in <duration>. No fixes applied.\n"
    );
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
fn a_doc_comment_without_a_required_section_names_it_in_the_finding() {
    assert_case("sections-missing", &[], EXIT_FINDINGS);
}

#[test]
fn a_heading_the_template_does_not_list_warns_only_where_the_tag_has_headings() {
    assert_case("unknown-section", &[], 0);

    let (_, stdout, stderr) = run("unknown-section", &[]);
    assert!(!stdout.contains("@description"), "{stdout}");
    assert!(stderr.ends_with("Found 1 warning.\n"), "{stderr}");
}

#[test]
fn listed_entries_out_of_template_order_report_tag_order() {
    assert_case("tag-order", &[], EXIT_FINDINGS);
}

#[test]
fn a_module_following_the_example_template_reports_nothing() {
    assert_case("template-clean", &[], 0);
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
fn a_placeholder_is_a_warning_until_strict_makes_it_an_error() {
    assert_case("constraints-placeholder", &[], 0);
    assert_expectation(
        "constraints-placeholder",
        "expected-strict.txt",
        &["--strict"],
        EXIT_FINDINGS,
    );

    let (_, _, stderr) = run("constraints-placeholder", &[]);
    assert!(stderr.ends_with("Found 1 warning.\n"), "{stderr}");
}

#[test]
fn a_broken_file_reports_parse_instead_of_crashing() {
    assert_case("parse", &[], EXIT_FINDINGS);
}

#[test]
fn a_rule_set_to_off_is_silent_and_one_set_to_warn_does_not_fail_the_run() {
    assert_case("rules-levels", &[], 0);

    let (_, stdout, stderr) = run("rules-levels", &[]);
    assert!(!stdout.contains("missing-doc"), "{stdout}");
    assert!(stderr.ends_with("Found 1 warning.\n"), "{stderr}");
}

#[test]
fn the_concise_reporter_prints_one_line_per_diagnostic() {
    assert_expectation(
        "reporter-concise",
        "expected.txt",
        &["--reporter=concise"],
        EXIT_FINDINGS,
    );
}

#[test]
fn the_github_reporter_prints_workflow_commands() {
    assert_expectation(
        "reporter-github",
        "expected.txt",
        &["--reporter=github"],
        EXIT_FINDINGS,
    );
}

#[test]
fn the_cap_shows_the_first_diagnostics_and_counts_the_rest() {
    assert_expectation(
        "max-diagnostics",
        "expected.txt",
        &["--max-diagnostics=1"],
        EXIT_FINDINGS,
    );

    let (_, _, stderr) = run("max-diagnostics", &["--max-diagnostics=1"]);
    assert!(
        stderr.starts_with("The number of diagnostics exceeds"),
        "{stderr}"
    );
    assert!(stderr.contains("Diagnostics not shown: 2.\n"), "{stderr}");

    let (_, _, lifted) = run("max-diagnostics", &["--max-diagnostics=none"]);
    assert!(!lifted.contains("Diagnostics not shown"), "{lifted}");
}

#[test]
fn error_on_warnings_fails_a_run_that_only_warned() {
    assert_case("error-on-warnings", &["--error-on-warnings"], EXIT_FINDINGS);
    assert_case("error-on-warnings", &[], 0);
}

#[test]
fn the_diagnostic_level_hides_warnings_without_dropping_them_from_the_summary() {
    assert_expectation(
        "diagnostic-level",
        "expected.txt",
        &["--diagnostic-level=error"],
        EXIT_FINDINGS,
    );

    let (_, stdout, stderr) = run("diagnostic-level", &["--diagnostic-level=error"]);
    assert!(!stdout.contains("constraints-placeholder"), "{stdout}");
    assert!(
        stderr.ends_with("Found 1 error.\nFound 1 warning.\n"),
        "{stderr}"
    );
}

#[test]
fn an_explicit_path_replaces_the_include_globs() {
    let output = binary()
        .current_dir(case("missing-doc"))
        .args(["check", "--no-format", "--colors=off", "Gaps.compact"])
        .output()
        .expect("the binary ran");

    assert_eq!(
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
        expected("missing-doc", "expected.txt")
    );
}

#[test]
fn an_explicit_config_anchors_discovery_at_the_working_directory() {
    let config = case("clean").join("compact.toml");
    let output = binary()
        .current_dir(case("missing-doc"))
        .args(["check", "--no-format", "--colors=off", "--config"])
        .arg(&config)
        .output()
        .expect("the binary ran");

    assert_eq!(
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
        expected("missing-doc", "expected.txt")
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
fn a_config_holding_only_another_tool_tables_exits_two() {
    let (code, _, stderr) = run("no-lint-table", &[]);

    assert_eq!(code, EXIT_ERROR, "{stderr}");
    assert!(stderr.contains("has no [lint] table"), "{stderr}");
}

#[test]
fn an_unreadable_config_exits_two() {
    let output = binary()
        .current_dir(case("clean"))
        .args(["check", "--no-format", "--config", "compact.toml.nope"])
        .output()
        .expect("the binary ran");

    assert_eq!(output.status.code(), Some(EXIT_ERROR));
}

#[test]
fn the_summary_goes_to_stderr_and_the_diagnostics_to_stdout() {
    let (_, stdout, stderr) = run("module-name", &[]);

    assert_eq!(
        without_duration(&stderr),
        "Checked 1 file in <duration>. No fixes applied.\nFound 1 error.\n"
    );
    assert!(
        stdout.contains("lint/module-name"),
        "the rule id belongs on stdout"
    );
}
