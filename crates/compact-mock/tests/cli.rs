//! `compact-mock` end to end, one fixture case per behaviour.
//!
//! A case under `tests/fixtures/<case>/` holds an input tree: configs and sources. Each
//! run of a case has two expectations under `expected/`: `<run>.txt`, the exit code,
//! stdout and stderr, and `<run>/`, every file the run creates or changes, at its path.
//! The harness copies the inputs to a temporary directory and runs the binary there, so
//! printed paths are relative to the case. `tests/fixtures/README.md` says how to bless.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use assert_cmd::prelude::*;
use tempfile::TempDir;

/// Set to `1`, each run writes its actual output to its expectations instead of comparing.
const BLESS: &str = "COMPACT_MOCK_BLESS";

const EXPECTED: &str = "expected";

/// Case entries that are expectations or provenance, never inputs.
const NOT_INPUTS: [&str; 3] = [EXPECTED, "NOTICE", "README.md"];

/// Stands for the temporary directory in a transcript.
const ROOT: &str = "<root>";

/// Every entry under a root: a file's bytes, or `None` for a directory.
type Tree = BTreeMap<String, Option<Vec<u8>>>;

fn case(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn blessing() -> bool {
    std::env::var_os(BLESS).is_some_and(|value| value == "1")
}

/// Every file and directory under `root`, keyed by its `/`-separated relative path.
fn tree(root: &Path) -> Tree {
    let mut entries = Tree::new();
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        let Ok(listing) = std::fs::read_dir(&directory) else {
            continue;
        };
        for entry in listing {
            let path = entry.expect("the directory is readable").path();
            let relative = path
                .strip_prefix(root)
                .expect("the walk stays under its root")
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            if path.is_dir() {
                pending.push(path);
                entries.insert(relative, None);
            } else {
                let bytes = std::fs::read(&path).expect("the file is readable");
                entries.insert(relative, Some(bytes));
            }
        }
    }
    entries
}

/// The files of `after` that are new or differ from `before`.
fn changed(before: &Tree, after: &Tree) -> BTreeMap<String, Vec<u8>> {
    after
        .iter()
        .filter_map(|(path, bytes)| {
            let bytes = bytes.as_ref()?;
            (before.get(path) != Some(&Some(bytes.clone()))).then(|| (path.clone(), bytes.clone()))
        })
        .collect()
}

/// A fresh temporary directory holding a copy of a case's inputs.
fn workspace(name: &str) -> TempDir {
    let directory = TempDir::new().expect("a temporary directory");
    for (relative, bytes) in tree(&case(name)) {
        let first = relative.split('/').next().unwrap_or_default();
        let Some(bytes) = bytes else {
            continue;
        };
        if NOT_INPUTS.contains(&first) {
            continue;
        }
        let target = directory.path().join(&relative);
        std::fs::create_dir_all(target.parent().expect("a parent")).expect("dirs are created");
        std::fs::write(target, bytes).expect("the input is copied");
    }
    directory
}

/// What one run of the binary printed.
struct Outcome {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Outcome {
    fn transcript(&self) -> String {
        format!(
            "exit: {}\n--- stdout\n{}--- stderr\n{}",
            self.code, self.stdout, self.stderr
        )
    }
}

/// Runs the binary with `args` in `directory`. The directory's path prints as [`ROOT`].
fn run(directory: &Path, args: &[&str]) -> Outcome {
    let output = Command::cargo_bin("compact-mock")
        .expect("the binary is built alongside this test")
        .current_dir(directory)
        .args(args)
        .output()
        .expect("the binary ran");
    let canonical = directory
        .canonicalize()
        .expect("the directory exists")
        .display()
        .to_string();
    let shown = |bytes: Vec<u8>| {
        String::from_utf8(bytes)
            .expect("the output is UTF-8")
            .replace(&canonical, ROOT)
    };
    Outcome {
        code: output.status.code().expect("the binary was not signalled"),
        stdout: shown(output.stdout),
        stderr: shown(output.stderr),
    }
}

/// `generate` followed by `args`.
fn generate<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut command = vec!["generate"];
    command.extend_from_slice(args);
    command
}

/// Compares a transcript with `expected/<run>.txt`, or writes it when blessing.
fn assert_transcript(name: &str, run: &str, actual: &str) {
    let path = case(name).join(EXPECTED).join(format!("{run}.txt"));
    if blessing() {
        std::fs::create_dir_all(path.parent().expect("a parent")).expect("dirs are created");
        std::fs::write(&path, actual).expect("the transcript is writable");
        return;
    }
    let expected = std::fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{name}: {} is missing", path.display()));
    assert_eq!(actual, expected, "{name}/{run}: transcript");
}

/// Compares the files a run created or changed with `expected/<run>/`, or writes them
/// when blessing.
fn assert_files(name: &str, run: &str, produced: &BTreeMap<String, Vec<u8>>) {
    let directory = case(name).join(EXPECTED).join(run);
    if blessing() {
        if directory.exists() {
            std::fs::remove_dir_all(&directory).expect("the old expectations are removed");
        }
        for (relative, bytes) in produced {
            let target = directory.join(relative);
            std::fs::create_dir_all(target.parent().expect("a parent")).expect("dirs");
            std::fs::write(target, bytes).expect("the expectation is writable");
        }
        return;
    }
    let expected: BTreeMap<String, Vec<u8>> = tree(&directory)
        .into_iter()
        .filter_map(|(path, bytes)| Some((path, bytes?)))
        .collect();
    assert_eq!(
        produced.keys().collect::<Vec<_>>(),
        expected.keys().collect::<Vec<_>>(),
        "{name}/{run}: files created or changed"
    );
    for (relative, bytes) in &expected {
        assert!(
            produced.get(relative) == Some(bytes),
            "{name}/{run}: {relative} differs from its expectation:\n{}",
            String::from_utf8_lossy(&produced[relative])
        );
    }
}

/// Runs `generate <args>` on a fresh copy of a case and compares the transcript and every
/// file the run created or changed with `expected/<run>`.
///
/// A failed run and any `--check` leave the tree exactly as they found it, directories
/// included. A successful `generate` deletes nothing, a second run prints only
/// `unchanged` and writes nothing, and `--check` then exits 0 without writing.
fn assert_run(name: &str, run_name: &str, args: &[&str]) -> TempDir {
    let directory = workspace(name);
    let before = tree(directory.path());
    let outcome = run(directory.path(), &generate(args));
    let after = tree(directory.path());
    assert_transcript(name, run_name, &outcome.transcript());
    let produced = changed(&before, &after);
    assert_files(name, run_name, &produced);

    let checking = args.contains(&"--check");
    if outcome.code != 0 || checking {
        assert_eq!(after, before, "{name}/{run_name}: the run changed the tree");
        return directory;
    }
    for path in before.keys() {
        assert!(
            after.contains_key(path),
            "{name}/{run_name}: {path} deleted"
        );
    }

    let again = run(directory.path(), &generate(args));
    assert_eq!(again.code, 0, "{name}/{run_name}: rerun\n{}", again.stderr);
    assert!(
        again
            .stdout
            .lines()
            .all(|line| line.starts_with("unchanged ")),
        "{name}/{run_name}: rerun wrote\n{}",
        again.stdout
    );
    assert!(again.stderr.contains(" 0 written, "), "{}", again.stderr);
    assert_eq!(
        tree(directory.path()),
        after,
        "{name}/{run_name}: rerun wrote"
    );

    let mut check = generate(args);
    check.push("--check");
    let checked = run(directory.path(), &check);
    assert_eq!(
        (checked.code, checked.stdout.as_str()),
        (0, ""),
        "{name}/{run_name}: --check after generate\n{}",
        checked.stderr
    );
    assert_eq!(
        tree(directory.path()),
        after,
        "{name}/{run_name}: --check wrote"
    );
    directory
}

/// Reads a generated or input file of a workspace.
fn read(directory: &TempDir, relative: &str) -> String {
    std::fs::read_to_string(directory.path().join(relative)).expect("the file exists")
}

/// Rewrites a file of a workspace through `edit`.
fn edit(directory: &TempDir, relative: &str, edit: impl FnOnce(String) -> String) {
    let path = directory.path().join(relative);
    let text = std::fs::read_to_string(&path).expect("the file exists");
    std::fs::write(&path, edit(text)).expect("the file is writable");
}

/// Runs `generate <args> --check` on a workspace after an edit and compares the
/// transcript with `expected/<run>.txt`. The check never changes the tree.
fn assert_check(name: &str, run_name: &str, directory: &TempDir, args: &[&str]) {
    let before = tree(directory.path());
    let mut check = generate(args);
    check.push("--check");
    let outcome = run(directory.path(), &check);
    assert_transcript(name, run_name, &outcome.transcript());
    assert_eq!(
        tree(directory.path()),
        before,
        "{name}/{run_name}: --check changed the tree"
    );
}

mod ownable_pair {
    use super::{assert_run, read};

    const CASE: &str = "ownable-pair";
    const MOCKS: &str = "src/access/test/mocks";

    #[test]
    fn the_ownable_pair_renders_the_authenticated_and_caller_mocks() {
        assert_run(CASE, "default", &[]);
    }

    #[test]
    fn without_auth_the_module_gets_one_mock_that_keeps_its_caller_parameters() {
        let directory = assert_run(CASE, "no-auth", &["--config", "no-auth.toml"]);
        let single = read(&directory, &format!("{MOCKS}/MockOwnable.compact"));
        let caller = std::fs::read_to_string(super::case(CASE).join(format!(
            "expected/default/{MOCKS}/MockOwnableCaller.compact"
        )))
        .expect("the caller expectation exists");
        assert_eq!(single, caller);
        assert!(!single.contains("AuthPrfPseudonym"));
    }

    #[test]
    fn ledger_false_drops_the_ledger_exports_and_a_variant_table_restores_them() {
        assert_run(CASE, "ledger", &["--config", "ledger.toml"]);
    }
}

mod unmarked_file {
    use super::assert_run;

    const CASE: &str = "unmarked-file";

    #[test]
    fn an_unmarked_target_is_refused_and_nothing_is_written() {
        assert_run(CASE, "default", &[]);
    }

    #[test]
    fn check_refuses_an_unmarked_target_with_the_same_error() {
        assert_run(CASE, "check", &["--check"]);
    }

    #[test]
    fn a_target_that_is_the_module_source_is_refused() {
        assert_run(CASE, "module-source", &["--config", "module-source.toml"]);
    }
}

mod rules {
    use super::{TempDir, assert_check, edit, generate, read, run, tree};

    const CASE: &str = "rules";
    const MOCK: &str = "src/calc/test/mocks/MockCalc.compact";

    fn assert_config(run_name: &str) -> TempDir {
        super::assert_config(CASE, run_name, &[])
    }

    #[test]
    fn disclose_wraps_the_forwarded_call_and_keeps_pure() {
        let directory = assert_config("disclose");
        let text = read(&directory, MOCK);
        assert_eq!(text.matches("disclose(").count(), 2);
    }

    #[test]
    fn disclose_on_a_unit_or_unknown_circuit_is_an_error() {
        assert_config("disclose-errors");
    }

    #[test]
    fn guard_true_wraps_every_exposed_circuit_and_drops_pure() {
        assert_config("guard-all");
    }

    #[test]
    fn a_guard_list_wraps_only_the_listed_circuits() {
        assert_config("guard-list");
    }

    #[test]
    fn rename_exposes_a_circuit_under_its_new_name_only() {
        assert_config("rename");
    }

    #[test]
    fn a_rename_target_that_clashes_or_names_a_hidden_circuit_is_an_error() {
        assert_config("rename-errors");
    }

    #[test]
    fn exclude_leaves_circuits_out_of_the_mock() {
        assert_config("exclude");
    }

    #[test]
    fn include_appends_the_fragment_path_relative_to_the_mock() {
        assert_config("include");
    }

    #[test]
    fn a_missing_misnamed_broken_or_constructor_fragment_is_an_error() {
        assert_config("include-errors");
    }

    #[test]
    fn check_reports_fragment_errors_like_generate() {
        super::assert_run(
            CASE,
            "include-errors-check",
            &["--config", "include-errors.toml", "--check"],
        );
    }

    #[test]
    fn check_reports_an_error_instead_of_drift() {
        let directory = after_edit(|text| text.replace("disclose(Calc_total())", "Calc_total()"));
        assert_check(
            CASE,
            "check-error",
            &directory,
            &["--config", "check-error.toml"],
        );
    }

    #[test]
    fn init_flag_gates_initialize_and_takes_the_last_parameter() {
        assert_config("init");
    }

    #[test]
    fn init_without_initialize_and_a_clashing_flag_are_errors() {
        assert_config("init-errors");
    }

    #[test]
    fn every_error_of_a_run_prints_in_order_and_nothing_is_written() {
        assert_config("errors-batch");
    }

    /// `generate --config disclose.toml`, then `edit` on the generated mock.
    fn after_edit(change: impl FnOnce(String) -> String) -> TempDir {
        let directory = assert_config("disclose");
        edit(&directory, MOCK, change);
        directory
    }

    #[test]
    fn check_on_a_clean_tree_prints_nothing_and_exits_zero() {
        let directory = assert_config("disclose");
        assert_check(
            CASE,
            "check-clean",
            &directory,
            &["--config", "disclose.toml"],
        );
    }

    #[test]
    fn check_prints_a_unified_diff_for_a_changed_file() {
        let directory = after_edit(|text| {
            text.replace("return disclose(Calc_total());", "return Calc_total();")
        });
        assert_check(
            CASE,
            "check-changed",
            &directory,
            &["--config", "disclose.toml"],
        );
    }

    /// The exit code and first stdout line of `--check` after `change`, which must leave
    /// the tree as it found it.
    fn check_after(change: impl FnOnce(String) -> String) -> (i32, String, String) {
        let directory = after_edit(change);
        let before = tree(directory.path());
        let outcome = run(
            directory.path(),
            &generate(&["--config", "disclose.toml", "--check"]),
        );
        assert_eq!(tree(directory.path()), before, "--check changed the tree");
        let first = outcome.stdout.lines().next().unwrap_or_default().to_owned();
        (outcome.code, first, outcome.stderr)
    }

    #[test]
    fn check_reports_crlf_endings_and_a_missing_final_newline_as_changed() {
        let changed = format!("changed {MOCK}");
        let (code, first, _) = check_after(|text| text.replace('\n', "\r\n"));
        assert_eq!((code, first.as_str()), (1, changed.as_str()));
        let (code, first, _) = check_after(|text| text.trim_end().to_owned());
        assert_eq!((code, first.as_str()), (1, changed.as_str()));
    }

    #[test]
    fn check_compares_a_file_whose_marker_moved_to_line_three() {
        let (code, first, _) = check_after(|text| format!("// a\n// b\n{text}"));
        assert_eq!((code, first), (1, format!("changed {MOCK}")));
    }

    #[test]
    fn check_refuses_a_file_whose_marker_moved_past_line_three_or_follows_a_bom() {
        let refusal = format!(
            "compact-mock: {MOCK} exists without the compact-mock marker; move or delete it to let compact-mock own it\n"
        );
        let (code, first, stderr) = check_after(|text| format!("// a\n// b\n// c\n{text}"));
        assert_eq!(
            (code, first.as_str(), stderr.as_str()),
            (2, "", refusal.as_str())
        );
        let (code, first, stderr) = check_after(|text| format!("\u{feff}{text}"));
        assert_eq!(
            (code, first.as_str(), stderr.as_str()),
            (2, "", refusal.as_str())
        );
    }

    #[test]
    fn check_reports_a_deleted_mock_as_missing_without_a_diff() {
        let directory = assert_config("disclose");
        std::fs::remove_file(directory.path().join(MOCK)).expect("the mock is deleted");
        assert_check(
            CASE,
            "check-missing",
            &directory,
            &["--config", "disclose.toml"],
        );
    }

    #[test]
    fn editing_a_fragment_never_makes_check_fail() {
        let directory = assert_config("include");
        edit(
            &directory,
            "src/calc/test/mocks/MockCalc.fragment.compact",
            |text| format!("{text}\nexport circuit extra(): [] {{\n}}\n"),
        );
        let outcome = run(
            directory.path(),
            &generate(&["--config", "include.toml", "--check"]),
        );
        assert_eq!((outcome.code, outcome.stdout.as_str()), (0, ""));
    }
}

/// `--config <name>.toml`.
fn config_args(name: &str) -> [String; 2] {
    ["--config".to_owned(), format!("{name}.toml")]
}

/// [`assert_run`] with `--config <run>.toml` and any extra arguments.
fn assert_config(name: &str, run_name: &str, extra: &[&str]) -> TempDir {
    let [flag, file] = config_args(run_name);
    let mut args = vec![flag.as_str(), file.as_str()];
    args.extend_from_slice(extra);
    assert_run(name, run_name, &args)
}

mod generics {
    use super::{assert_config, read, run, workspace};

    const CASE: &str = "generics";

    #[test]
    fn module_args_reach_both_module_imports_and_circuit_args_reach_initialize() {
        assert_config(CASE, "module-generics", &[]);
    }

    #[test]
    fn a_module_args_count_mismatch_and_an_unargued_generic_initialize_are_errors() {
        assert_config(CASE, "module-generics-errors", &[]);
    }

    #[test]
    fn circuit_args_substitute_a_circuit_generic_that_shadows_a_module_generic() {
        assert_config(CASE, "circuit-generics", &[]);
    }

    #[test]
    fn circuit_args_with_the_wrong_count_on_a_plain_circuit_or_missing_are_errors() {
        assert_config(CASE, "circuit-generics-errors", &[]);
    }

    #[test]
    fn the_key_order_of_circuit_args_does_not_change_the_output() {
        let first = assert_config(CASE, "circuit-generics", &[]);
        let second = workspace(CASE);
        let outcome = run(
            second.path(),
            &["generate", "--config", "circuit-generics-reordered.toml"],
        );
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        let mock = "src/pick/test/mocks/MockPick.compact";
        assert_eq!(read(&first, mock), read(&second, mock));
    }
}

mod types {
    use super::assert_config;

    const CASE: &str = "types";

    #[test]
    fn module_local_selective_and_prefixed_types_are_spelled_imported_and_exported() {
        assert_config(CASE, "prefixed-types", &[]);
    }

    #[test]
    fn a_wrapper_naming_an_unexported_type_or_a_rename_onto_a_type_is_an_error() {
        assert_config(CASE, "prefixed-types-errors", &[]);
    }

    #[test]
    fn an_export_list_contributes_its_circuits_and_ledger_fields_in_place() {
        assert_config(CASE, "export-list-ledger", &[]);
    }

    #[test]
    fn an_export_list_circuit_that_needs_a_wrapper_is_an_error() {
        assert_config(CASE, "export-list-errors", &[]);
    }
}

mod auth_layer {
    use super::{TempDir, assert_config, read};

    const CASE: &str = "auth-layer";
    const MOCKS: &str = "src/door/test/mocks";

    fn mock(directory: &TempDir, name: &str) -> String {
        read(directory, &format!("{MOCKS}/{name}.compact"))
    }

    #[test]
    fn caller_parameters_match_by_declaration_through_every_import_form() {
        let directory = assert_config(CASE, "caller-matching", &[]);
        for name in ["MockDoorCaller", "MockPlainCaller", "MockTwin"] {
            let text = mock(&directory, name);
            assert!(!text.contains("auth/Gate"), "{name}");
            assert!(!text.contains("Gate_authenticate("), "{name}");
        }
        let door = mock(&directory, "MockDoor");
        assert_eq!(
            door.matches("Gate_authenticate(pad(32, \"MockDoor\"))")
                .count(),
            4
        );
        assert!(!door.contains("Badge"));
    }

    #[test]
    fn a_module_whose_only_caller_parameter_is_excluded_or_in_initialize_still_splits() {
        let directory = assert_config(CASE, "expansion", &[]);
        assert_eq!(
            mock(&directory, "MockBell"),
            mock(&directory, "MockBellCaller")
        );
    }

    #[test]
    fn variant_tables_replace_entry_keys_and_the_salt_follows_the_authenticated_name() {
        assert_config(CASE, "variants", &[]);
    }

    #[test]
    fn a_salt_change_makes_check_fail_on_the_authenticated_mock_only() {
        let directory = assert_config(CASE, "variants", &[]);
        super::edit(&directory, "variants.toml", |text| {
            text.replace("\"front door\"", "\"back door\"")
        });
        let outcome = super::run(
            directory.path(),
            &["generate", "--config", "variants.toml", "--check"],
        );
        assert_eq!(outcome.code, 1);
        let changed: Vec<&str> = outcome
            .stdout
            .lines()
            .filter(|line| !line.starts_with([' ', '-', '+', '@']))
            .collect();
        assert_eq!(changed, [format!("changed {MOCKS}/MockEntry.compact")]);
        assert_eq!(outcome.stdout.matches("+    Door_initialize(").count(), 1);
        assert_eq!(outcome.stdout.matches("back door").count(), 4);
    }

    #[test]
    fn a_caller_inside_a_compound_type_or_a_nominal_alias_is_an_error() {
        assert_config(CASE, "contains-caller", &[]);
    }

    #[test]
    fn a_parameter_type_that_does_not_resolve_fails_closed() {
        assert_config(CASE, "unresolved", &[]);
    }

    #[test]
    fn salts_up_to_thirty_two_utf8_bytes_land_in_the_call_byte_for_byte() {
        let directory = assert_config(CASE, "salt-boundary", &[]);
        for (name, salt) in [
            ("MockHingeA", "a".repeat(32)),
            ("MockHingeB", format!("{}\u{e9}", "a".repeat(30))),
            ("MockHingeC", format!("{}aaaa", "\u{1f642}".repeat(7))),
            ("MockHingeD", "e\u{301}".to_owned()),
        ] {
            assert!(salt.len() <= 32, "{name}");
            let call = format!("Gate_authenticate(pad(32, \"{salt}\"))");
            assert!(mock(&directory, name).contains(&call), "{name}");
        }
    }

    #[test]
    fn a_long_empty_quoted_escaped_or_control_salt_is_an_error() {
        assert_config(CASE, "salt-errors", &[]);
    }

    #[test]
    fn selected_names_print_in_config_order_once() {
        super::assert_run(
            CASE,
            "name-filter-order",
            &[
                "--config",
                "expansion.toml",
                "MockHingeCaller",
                "MockBell",
                "MockHingeCaller",
            ],
        );
    }

    #[test]
    fn an_unknown_name_or_a_variant_left_out_by_variants_is_an_error() {
        super::assert_run(
            CASE,
            "name-filter-unknown",
            &["--config", "expansion.toml", "MockNope"],
        );
        super::assert_run(
            CASE,
            "name-filter-variant",
            &["--config", "variants.toml", "MockHinge"],
        );
    }

    #[test]
    fn an_expansion_error_in_an_unselected_entry_still_fails_the_run() {
        assert_config(CASE, "name-filter-broken", &["MockHinge"]);
    }

    #[test]
    fn a_plan_error_in_an_unselected_variant_is_not_reported() {
        assert_config(CASE, "name-filter-unselected", &["MockHinge"]);
    }

    #[test]
    fn the_source_tree_never_names_a_compact_contracts_auth_path() {
        let source = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        for entry in std::fs::read_dir(source).expect("src is readable") {
            let path = entry.expect("the entry is readable").path();
            let text = std::fs::read_to_string(&path).expect("the source is readable");
            for name in ["AuthPrfPseudonym", "identifier/Identifier"] {
                assert!(!text.contains(name), "{} names {name}", path.display());
            }
        }
    }
}

mod rebase {
    use super::{assert_config, assert_run};

    const CASE: &str = "rebase";

    #[test]
    fn import_paths_are_rebased_from_each_output_directory() {
        assert_run(CASE, "default", &[]);
    }

    #[test]
    fn a_top_level_out_dir_is_the_default_and_an_entry_out_dir_overrides_it() {
        assert_config(CASE, "out-dir", &[]);
    }

    #[test]
    fn parent_for_a_module_at_the_root_of_src_is_an_error() {
        assert_config(CASE, "parent-at-root", &[]);
    }
}

mod determinism {
    use std::collections::BTreeMap;
    use std::path::Path;

    use super::{assert_run, changed, run, tree, workspace};

    /// Runs `generate <args>` from `cwd` (relative to a fresh copy of `name`) and returns
    /// the files it wrote.
    fn written(name: &str, cwd: &str, args: &[&str]) -> BTreeMap<String, Vec<u8>> {
        let directory = workspace(name);
        let before = tree(directory.path());
        let mut command = vec!["generate"];
        command.extend_from_slice(args);
        let outcome = run(&directory.path().join(cwd), &command);
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        changed(&before, &tree(directory.path()))
    }

    #[test]
    fn the_output_is_the_same_from_any_working_directory() {
        let from_root = written("rebase", ".", &[]);
        assert_eq!(from_root.len(), 4);
        assert_eq!(written("rebase", "src/near", &[]), from_root);
        assert_eq!(
            written(
                "rebase",
                "src/far",
                &["--config", "../../compact-mock.toml"]
            ),
            from_root
        );
    }

    #[test]
    fn crlf_sources_render_the_same_mocks() {
        for (name, run_name, args) in [
            ("ownable-pair", "default", &[][..]),
            (
                "types",
                "prefixed-types",
                &["--config", "prefixed-types.toml"][..],
            ),
            (
                "auth-layer",
                "caller-matching",
                &["--config", "caller-matching.toml"][..],
            ),
        ] {
            let directory = workspace(name);
            for (path, bytes) in tree(directory.path()) {
                let Some(bytes) = bytes else {
                    continue;
                };
                if Path::new(&path)
                    .extension()
                    .is_some_and(|extension| extension == "compact")
                {
                    let text = String::from_utf8(bytes).expect("sources are UTF-8");
                    std::fs::write(directory.path().join(&path), text.replace('\n', "\r\n"))
                        .expect("the source is rewritten");
                }
            }
            let before = tree(directory.path());
            let mut command = vec!["generate"];
            command.extend_from_slice(args);
            let outcome = run(directory.path(), &command);
            assert_eq!(outcome.code, 0, "{name}: {}", outcome.stderr);
            let produced = changed(&before, &tree(directory.path()));
            let expected: BTreeMap<String, Vec<u8>> =
                tree(&super::case(name).join("expected").join(run_name))
                    .into_iter()
                    .filter_map(|(path, bytes)| Some((path, bytes?)))
                    .collect();
            assert_eq!(produced, expected, "{name}");
        }
    }

    #[test]
    fn check_on_a_fresh_tree_reports_every_mock_missing_and_creates_nothing() {
        assert_run("ownable-pair", "check-missing", &["--check"]);
    }

    #[test]
    fn a_failed_write_keeps_earlier_files_and_prints_no_summary() {
        let directory = workspace("rebase");
        std::fs::write(
            directory.path().join("src/far/test"),
            "a file, not a directory",
        )
        .expect("the blocker is written");
        let outcome = run(directory.path(), &["generate"]);
        assert_eq!(outcome.code, 2);
        assert_eq!(
            outcome.stdout,
            "wrote src/test/mocks/MockRoot.compact\n\
             wrote src/a/mocks/MockDeep.compact\n\
             wrote src/near/MockNear.compact\n"
        );
        let lines: Vec<&str> = outcome.stderr.lines().collect();
        assert_eq!(lines.len(), 2, "{}", outcome.stderr);
        assert_eq!(
            lines[0],
            "compact-mock: cannot write src/far/test/mocks/MockFar.compact"
        );
        assert!(lines[1].starts_with("  caused by: "));
        let after = tree(directory.path());
        assert!(after.contains_key("src/near/MockNear.compact"));
        assert!(
            after
                .keys()
                .all(|path| Path::new(path).extension().is_none_or(|ext| ext != "tmp")),
            "{after:?}"
        );
    }
}
