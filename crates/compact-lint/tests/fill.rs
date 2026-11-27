//! `compact-lint fill-constraints` end to end, against a fake `compact` binary.
//!
//! The fake at `tests/fixtures/fill-fake-compact/bin/compact` prints the compiler's
//! progress lines for a hard-coded table and writes a matching contract report, so the
//! pty path is exercised where the real toolchain is absent.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use assert_cmd::prelude::*;
use tempfile::TempDir;

/// Exit code for an error-level diagnostic, or a warning under `--error-on-warnings`.
const EXIT_FINDINGS: i32 = 1;

/// Exit code for a config, IO or compiler error.
const EXIT_ERROR: i32 = 2;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn case(name: &str) -> PathBuf {
    fixtures()
        .join(format!("fill-{name}"))
        .canonicalize()
        .expect("the fixture case exists")
}

fn fake_compact() -> PathBuf {
    fixtures()
        .join("fill-fake-compact/bin/compact")
        .canonicalize()
        .expect("the fake compiler exists")
}

fn binary() -> Command {
    Command::cargo_bin("compact-lint").expect("the binary is built alongside this test")
}

/// Copies the case's config and `before/` tree into a fresh temporary directory.
fn work(name: &str) -> TempDir {
    let directory = TempDir::new().expect("a temporary directory is available");
    let root = case(name);

    std::fs::copy(
        root.join("compact.toml"),
        directory.path().join("compact.toml"),
    )
    .expect("the case has a config");
    copy_tree(&root.join("before"), directory.path());

    directory
}

fn copy_tree(from: &Path, to: &Path) {
    for entry in std::fs::read_dir(from).expect("the tree is readable") {
        let entry = entry.expect("the entry is readable");
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            std::fs::create_dir_all(&target).expect("the target is writable");
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("the file is copyable");
        }
    }
}

/// Every `.compact` file under `root`, keyed by its path relative to it.
fn sources(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut found = BTreeMap::new();
    collect(root, root, true, &mut found);
    found
}

/// Every file under `root`, artifacts included, keyed by its path relative to it.
fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut found = BTreeMap::new();
    collect(root, root, false, &mut found);
    found
}

fn collect(
    root: &Path,
    directory: &Path,
    only_sources: bool,
    out: &mut BTreeMap<PathBuf, Vec<u8>>,
) {
    for entry in std::fs::read_dir(directory).expect("the tree is readable") {
        let entry = entry.expect("the entry is readable");
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, only_sources, out);
        } else if !only_sources
            || path
                .extension()
                .is_some_and(|extension| extension == "compact")
        {
            let relative = path.strip_prefix(root).expect("the path is under the root");
            out.insert(
                relative.to_owned(),
                std::fs::read(&path).expect("the source is readable"),
            );
        }
    }
}

fn expected(name: &str, file: &str) -> String {
    std::fs::read_to_string(case(name).join(file)).expect("the case has an expectation")
}

/// Runs `fill-constraints` inside `directory`, pointed at the fake compiler.
fn fill(directory: &Path, extra: &[&str]) -> Output {
    fill_with_env(directory, extra, &[])
}

fn fill_with_env(directory: &Path, extra: &[&str], env: &[(&str, &str)]) -> Output {
    binary()
        .current_dir(directory)
        .args(["fill-constraints", "--colors=off", "--compact-bin"])
        .arg(fake_compact())
        .args(extra)
        .envs(env.iter().copied())
        .output()
        .expect("the binary ran")
}

fn code_and_stdout(output: &Output) -> (i32, String) {
    (
        output.status.code().expect("the binary was not signalled"),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    )
}

/// Runs another subcommand inside `directory` and returns its exit code and stdout.
fn run(directory: &Path, args: &[&str]) -> (i32, String) {
    let output = binary()
        .current_dir(directory)
        .args(args)
        .arg("--colors=off")
        .output()
        .expect("the binary ran");
    code_and_stdout(&output)
}

/// The whole contract of a measurable case: it fills, it lands, it settles, it previews.
///
/// A case holds `expected.txt` for the write run, `expected-settled.txt` for what a
/// second run still reports, and `expected-dry-run.txt` for the preview.
fn assert_case(name: &str, extra: &[&str], exit: i32) {
    let directory = work(name);
    let root = directory.path();

    let (code, stdout) = code_and_stdout(&fill(root, extra));
    assert_eq!(
        stdout,
        expected(name, "expected.txt"),
        "stdout for case {name}"
    );
    assert_eq!(code, exit, "exit code for case {name}");
    assert_eq!(
        sources(root),
        sources(&case(name).join("after")),
        "rewritten sources for case {name}"
    );

    let (code, stdout) = run(root, &["check", "--strict", "--no-format"]);
    assert_eq!(stdout, "", "check is clean after filling case {name}");
    assert_eq!(code, 0, "check exit code after filling case {name}");

    let (code, stdout) = code_and_stdout(&fill(root, extra));
    assert_eq!(
        stdout,
        expected(name, "expected-settled.txt"),
        "a second run on case {name}"
    );
    assert_eq!(code, exit, "second run exit code for case {name}");

    let preview = work(name);
    let before = tree(preview.path());
    let mut arguments = extra.to_vec();
    arguments.push("--dry-run");
    let (code, stdout) = code_and_stdout(&fill(preview.path(), &arguments));
    assert_eq!(
        stdout,
        expected(name, "expected-dry-run.txt"),
        "dry-run stdout for case {name}"
    );
    assert_eq!(code, exit, "dry-run exit code for case {name}");
    assert_eq!(tree(preview.path()), before, "dry-run wrote to case {name}");
}

#[test]
fn placeholders_and_stale_values_take_the_measurement() {
    assert_case("basic", &[], 0);
}

#[test]
fn a_preset_matching_a_self_glob_compiles_itself() {
    assert_case("self", &[], 0);
}

#[test]
fn an_override_names_the_contract_that_measures_a_file() {
    assert_case("override", &[], 0);
}

#[test]
fn a_seeded_artifact_fills_without_a_compiler() {
    assert_case("no-compile", &["--no-compile"], 0);
}

#[test]
fn a_note_stays_while_the_measurement_matches() {
    assert_case("note", &["--no-compile"], 0);
}

#[test]
fn a_circuit_the_report_marks_unproved_stays_unmeasured() {
    let directory = work("basic");
    let (_, stdout) = code_and_stdout(&fill(directory.path(), &[]));

    assert!(
        stdout.contains("Circuit `initialize` has no measurement."),
        "{stdout}"
    );
    assert!(
        !stdout.contains("Set @constraints to k=5, rows=10"),
        "{stdout}"
    );
}

#[test]
fn a_file_with_no_measurement_source_reports_once() {
    let directory = work("missing-source");
    let root = directory.path();
    let before = sources(root);

    let (code, stdout) = code_and_stdout(&fill(root, &[]));

    assert_eq!(stdout, expected("missing-source", "expected.txt"));
    assert_eq!(code, 0);
    assert_eq!(sources(root), before);
}

#[test]
fn with_a_mock_table_the_generated_mock_is_tried_first_under_its_test_dir() {
    let directory = work("mock-source");
    let (_, stdout) = code_and_stdout(&fill(directory.path(), &["--dry-run"]));
    assert!(
        stdout.contains(
            "Tried src/orphan/test/unit/artifacts/FakeOrphan.compact, src/orphan/test/unit/artifacts/MockOrphan.compact, src/orphan/test/mocks/MockOrphan.compact, src/test/mocks/MockOrphan.compact;"
        ),
        "{stdout}"
    );
}

#[test]
fn an_unmeasured_circuit_fails_the_run_only_at_error_level_or_with_error_on_warnings() {
    let directory = work("basic");
    let root = directory.path();
    let (code, _) = code_and_stdout(&fill(root, &["--dry-run"]));
    assert_eq!(code, 0, "at the default warn level");

    let (code, _) = code_and_stdout(&fill(root, &["--dry-run", "--error-on-warnings"]));
    assert_eq!(code, EXIT_FINDINGS, "with --error-on-warnings");

    let config = root.join("compact.toml");
    let mut text = std::fs::read_to_string(&config).expect("the config is readable");
    text.push_str("\n[lint.rules]\nconstraints-unmeasured = \"error\"\n");
    std::fs::write(&config, text).expect("the config is writable");
    let (code, _) = code_and_stdout(&fill(root, &["--dry-run"]));
    assert_eq!(code, EXIT_FINDINGS, "at the error level");
}

#[test]
fn a_failed_compile_exits_two_with_the_output_tail() {
    let directory = work("compiler-fails");
    let output = fill(directory.path(), &[]);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(output.status.code(), Some(EXIT_ERROR));
    assert!(stderr.contains("MockBroken.compact"), "{stderr}");
    assert!(stderr.contains("type mismatch"), "{stderr}");
    assert!(!stderr.contains('\u{1b}'), "the raw pty stream leaked");
}

#[test]
fn a_source_saved_during_the_compile_is_not_overwritten() {
    let directory = work("basic");
    let file = directory.path().join("src/access/Ownable.compact");
    let output = fill_with_env(
        directory.path(),
        &[],
        &[(
            "FAKE_COMPACT_EDIT",
            file.to_str().expect("the path is UTF-8"),
        )],
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = std::fs::read_to_string(&file).expect("the source is readable");

    assert_eq!(output.status.code(), Some(EXIT_ERROR));
    assert!(stderr.contains("Ownable.compact"), "{stderr}");
    assert!(text.ends_with("// saved during the compile\n"), "{text}");
    assert!(text.contains("@constraints k=?, rows=?"), "{text}");
}

#[test]
fn no_color_in_the_environment_still_measures() {
    let directory = work("basic");
    let (code, stdout) =
        code_and_stdout(&fill_with_env(directory.path(), &[], &[("NO_COLOR", "1")]));

    assert_eq!(stdout, expected("basic", "expected.txt"));
    assert_eq!(code, 0);
}

#[test]
fn rows_the_compiler_wraps_onto_one_line_are_all_measured() {
    let directory = work("basic");
    let (code, stdout) = code_and_stdout(&fill_with_env(
        directory.path(),
        &[],
        &[("FAKE_COMPACT_WRAP", "1")],
    ));

    assert_eq!(stdout, expected("basic", "expected.txt"));
    assert_eq!(code, 0);
}

#[test]
fn a_compile_with_no_progress_lines_exits_two_without_writing_circuit_info() {
    let directory = work("no-compile");
    let artifact = directory
        .path()
        .join("artifacts/MockOwnable/circuit-info.json");
    let before = std::fs::read(&artifact).expect("the seeded artifact is readable");

    let output = fill_with_env(directory.path(), &[], &[("FAKE_COMPACT_SILENT", "1")]);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(output.status.code(), Some(EXIT_ERROR));
    assert!(stderr.contains("MockOwnable.compact"), "{stderr}");
    assert!(stderr.contains("owner"), "{stderr}");
    assert_eq!(
        std::fs::read(&artifact).expect("the artifact is still readable"),
        before
    );
}

#[test]
fn a_missing_artifact_exits_two_and_names_the_flag() {
    let directory = work("basic");
    let output = fill(directory.path(), &["--no-compile"]);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(output.status.code(), Some(EXIT_ERROR));
    assert!(
        stderr.contains("artifacts/MockOwnable/circuit-info.json"),
        "{stderr}"
    );
    assert!(stderr.contains("--no-compile"), "{stderr}");
}

#[test]
fn a_compile_writes_the_artifact_circuit_info() {
    let directory = work("override");
    fill(directory.path(), &[]);

    let artifact = std::fs::read_to_string(
        directory
            .path()
            .join("artifacts/MockUtilities/circuit-info.json"),
    )
    .expect("the artifact was written");

    assert!(artifact.contains("\"generatedAt\""), "{artifact}");
    assert!(
        artifact.contains("\"source\": \"src/utils/test/mocks/MockUtilities.compact\""),
        "{artifact}"
    );
    assert!(artifact.contains("\"rows\": 310"), "{artifact}");
    assert!(
        directory
            .path()
            .join("artifacts/MockUtilities/compiler/contract-info.json")
            .is_file(),
        "the compiler's own report sits beside it"
    );
}

#[test]
fn a_hierarchical_artifact_tree_is_found_by_stem() {
    let directory = work("no-compile");
    let artifacts = directory.path().join("artifacts");
    std::fs::create_dir_all(artifacts.join("access")).expect("the tree is writable");
    std::fs::rename(
        artifacts.join("MockOwnable"),
        artifacts.join("access/MockOwnable"),
    )
    .expect("the contract directory is movable");

    let (code, stdout) = code_and_stdout(&fill(directory.path(), &["--no-compile"]));

    assert_eq!(stdout, expected("no-compile", "expected.txt"));
    assert_eq!(code, 0);
}

#[test]
fn two_artifacts_with_one_stem_are_an_error() {
    let directory = work("no-compile");
    let artifacts = directory.path().join("artifacts");
    for subdirectory in ["access", "token"] {
        let target = artifacts.join(subdirectory).join("MockOwnable");
        std::fs::create_dir_all(&target).expect("the tree is writable");
        std::fs::copy(
            artifacts.join("MockOwnable/circuit-info.json"),
            target.join("circuit-info.json"),
        )
        .expect("the artifact is copyable");
    }
    std::fs::remove_dir_all(artifacts.join("MockOwnable")).expect("the tree is writable");

    let output = fill(directory.path(), &["--no-compile"]);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(output.status.code(), Some(EXIT_ERROR));
    assert!(stderr.contains("named MockOwnable"), "{stderr}");
    assert!(stderr.contains("access/MockOwnable"), "{stderr}");
    assert!(stderr.contains("token/MockOwnable"), "{stderr}");
}

#[test]
fn the_summary_goes_to_stderr_and_the_changes_to_stdout() {
    let directory = work("basic");
    let output = fill(directory.path(), &[]);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(stderr.starts_with("Checked 1 file in "), "{stderr}");
    assert!(
        stderr.ends_with(". Filled 2 values in 1 file.\nFound 1 warning.\n"),
        "{stderr}"
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(" fill  FIXED  "),
        "the changes belong on stdout"
    );
}

#[test]
fn kept_artifacts_land_in_the_directory_the_flag_names() {
    let directory = work("override");
    let artifacts = directory.path().join("artifacts");
    fill(
        directory.path(),
        &[
            "--artifacts",
            artifacts.to_str().expect("the path is UTF-8"),
        ],
    );

    assert!(
        artifacts
            .join("MockUtilities/compiler/contract-info.json")
            .is_file()
    );
}
