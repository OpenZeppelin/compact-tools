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

/// Exit code for a run that left a tagged circuit unmeasured.
const EXIT_UNMEASURED: i32 = 1;

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
        root.join("compact-lint.toml"),
        directory.path().join("compact-lint.toml"),
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
    collect(root, root, &mut found);
    found
}

fn collect(root: &Path, directory: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
    for entry in std::fs::read_dir(directory).expect("the tree is readable") {
        let entry = entry.expect("the entry is readable");
        let path = entry.path();
        if path.is_dir() {
            collect(root, &path, out);
        } else if path
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
    binary()
        .current_dir(directory)
        .args(["fill-constraints", "--colors=off", "--compact-bin"])
        .arg(fake_compact())
        .args(extra)
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
    let before = sources(preview.path());
    let mut arguments = extra.to_vec();
    arguments.push("--dry-run");
    let (code, stdout) = code_and_stdout(&fill(preview.path(), &arguments));
    assert_eq!(
        stdout,
        expected(name, "expected-dry-run.txt"),
        "dry-run stdout for case {name}"
    );
    assert_eq!(code, exit, "dry-run exit code for case {name}");
    assert_eq!(
        sources(preview.path()),
        before,
        "dry-run wrote to case {name}"
    );
}

#[test]
fn placeholders_and_stale_values_take_the_measurement() {
    assert_case("basic", &[], EXIT_UNMEASURED);
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
fn a_seeded_cache_fills_without_a_compiler() {
    assert_case("no-compile", &["--no-compile"], 0);
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
fn a_file_with_no_measurement_source_reports_once_and_exits_one() {
    let directory = work("missing-source");
    let root = directory.path();
    let before = sources(root);

    let (code, stdout) = code_and_stdout(&fill(root, &[]));

    assert_eq!(stdout, expected("missing-source", "expected.txt"));
    assert_eq!(code, EXIT_UNMEASURED);
    assert_eq!(sources(root), before);
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
fn a_missing_cache_entry_exits_two_and_names_the_flag() {
    let directory = work("basic");
    let output = fill(directory.path(), &["--no-compile"]);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert_eq!(output.status.code(), Some(EXIT_ERROR));
    assert!(stderr.contains(".circuit-info.json"), "{stderr}");
    assert!(stderr.contains("--no-compile"), "{stderr}");
}

#[test]
fn a_compile_writes_the_cache_the_builder_shares() {
    let directory = work("override");
    fill(directory.path(), &[]);

    let cache = std::fs::read_to_string(
        directory
            .path()
            .join("src/utils/test/mocks/.circuit-info.json"),
    )
    .expect("the cache was written");

    assert!(cache.contains("\"generatedAt\""), "{cache}");
    assert!(cache.contains("\"MockUtilities.compact\""), "{cache}");
    assert!(cache.contains("\"rows\": 310"), "{cache}");
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
