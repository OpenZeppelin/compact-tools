//! `compact-lint fix` end to end, one fixture case per rule.
//!
//! A case holds `compact-lint.toml`, `before/`, `after/` and `expected.txt`. The run
//! works on a copy of `before/`, so the fixtures themselves are never rewritten.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use assert_cmd::prelude::*;
use tempfile::TempDir;

/// Exit code for a `--dry-run` that would edit.
const EXIT_EDITS: i32 = 1;

fn case(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(format!("fix-{name}"))
        .canonicalize()
        .expect("the fixture case exists")
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

fn expected(name: &str) -> String {
    std::fs::read_to_string(case(name).join("expected.txt")).expect("the case has an expectation")
}

/// Runs a subcommand inside `directory` and returns its exit code and stdout.
fn run(directory: &Path, args: &[&str]) -> (i32, String) {
    let output = binary()
        .current_dir(directory)
        .args(args)
        .output()
        .expect("the binary ran");

    (
        output.status.code().expect("the binary was not signalled"),
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
    )
}

/// The whole contract of a fixable case: it fixes, it lands, it settles, it previews.
fn assert_case(name: &str) {
    let directory = work(name);
    let root = directory.path();

    let (code, stdout) = run(root, &["fix"]);
    assert_eq!(stdout, expected(name), "stdout for case {name}");
    assert_eq!(code, 0, "exit code for case {name}");
    assert_eq!(
        sources(root),
        sources(&case(name).join("after")),
        "rewritten sources for case {name}"
    );

    let (code, stdout) = run(root, &["check", "--no-format"]);
    assert_eq!(stdout, "", "check is clean after fixing case {name}");
    assert_eq!(code, 0, "check exit code after fixing case {name}");

    let (code, stdout) = run(root, &["fix"]);
    assert_eq!(stdout, "", "a second fix on case {name} edits nothing");
    assert_eq!(code, 0, "second fix exit code for case {name}");

    let preview = work(name);
    let before = sources(preview.path());
    let (code, stdout) = run(preview.path(), &["fix", "--dry-run"]);
    assert_eq!(stdout, expected(name), "dry-run stdout for case {name}");
    assert_eq!(code, EXIT_EDITS, "dry-run exit code for case {name}");
    assert_eq!(
        sources(preview.path()),
        before,
        "dry-run wrote to case {name}"
    );
}

#[test]
fn undocumented_declarations_of_every_kind_take_a_skeleton() {
    assert_case("skeleton");
}

#[test]
fn a_required_tag_goes_into_the_comment_that_lacks_it() {
    assert_case("missing-tag");
}

#[test]
fn the_constraints_annotation_follows_the_description_block() {
    assert_case("constraints");
}

#[test]
fn a_forbidden_tag_with_a_replacement_is_renamed_in_place() {
    assert_case("rename");
}

#[test]
fn a_stale_module_tag_takes_the_module_name() {
    assert_case("module-name");
}

#[test]
fn a_crlf_source_keeps_its_line_endings() {
    assert_case("crlf");
}

#[test]
fn nothing_fixable_writes_nothing_and_exits_zero() {
    let directory = work("unfixable");
    let root = directory.path();
    let before = sources(root);

    let (code, stdout) = run(root, &["fix"]);
    assert_eq!(stdout, "");
    assert_eq!(code, 0);
    assert_eq!(sources(root), before);

    let (code, stdout) = run(root, &["fix", "--dry-run"]);
    assert_eq!(stdout, "");
    assert_eq!(code, 0);
}

#[test]
fn the_summary_goes_to_stderr_and_the_edits_to_stdout() {
    let directory = work("rename");
    let output = binary()
        .current_dir(directory.path())
        .arg("fix")
        .output()
        .expect("the binary ran");

    let stderr = String::from_utf8(output.stderr).expect("the summary is UTF-8");
    assert_eq!(stderr.trim_end(), "2 edits in 1 files");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains(": fix: "),
        "the edits belong on stdout"
    );
}

#[test]
fn an_explicit_config_replaces_the_one_beside_the_sources() {
    let directory = work("rename");
    std::fs::remove_file(directory.path().join("compact-lint.toml"))
        .expect("the copied config is removable");

    let config = case("rename").join("compact-lint.toml");
    let output = binary()
        .current_dir(directory.path())
        .args(["fix", "--config"])
        .arg(&config)
        .output()
        .expect("the binary ran");

    assert_eq!(
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
        expected("rename")
    );
}

#[test]
fn a_missing_path_exits_two() {
    let directory = work("rename");
    let (code, _) = run(directory.path(), &["fix", "Nope.compact"]);

    assert_eq!(code, 2);
}
