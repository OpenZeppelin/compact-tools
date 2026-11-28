//! `compact-mock` end to end, one fixture case per behaviour.
//!
//! A case under `tests/fixtures/<case>/` holds an input tree: configs and sources. Each
//! run of a case has two expectations under `expected/`: `<run>.txt`, the exit code,
//! stdout, stderr and every path the run removed, and `<run>/`, every file the run creates
//! or changes, at its path. A path segment `artifacts` is spelled `_artifacts` in inputs
//! and expectations, because the root `.gitignore` hides `artifacts/`. The harness copies
//! the inputs to a temporary directory and runs the binary there, so printed paths are
//! relative to the case. `tests/fixtures/README.md` says how to bless.

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

/// The directory every write and removal lies under.
const ARTIFACTS: &str = "artifacts";

/// How fixtures spell [`ARTIFACTS`] in a path.
const SPELLED_ARTIFACTS: &str = "_artifacts";

/// Variables the binary reads. Every run starts without them.
const SCRUBBED: [&str; 2] = ["SKIP_ZK", "COMPACT_MOCK_COMPACT_BIN"];

/// One entry of a tree. Links are recorded, never followed.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Entry {
    Dir,
    File(Vec<u8>),
    Link(PathBuf),
}

/// Every entry under a root, keyed by its `/`-separated relative path.
type Tree = BTreeMap<String, Entry>;

fn case(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn blessing() -> bool {
    std::env::var_os(BLESS).is_some_and(|value| value == "1")
}

fn respell(path: &str, from: &str, to: &str) -> String {
    path.split('/')
        .map(|segment| if segment == from { to } else { segment })
        .collect::<Vec<_>>()
        .join("/")
}

/// A fixture path as it lies on disk in a run.
fn on_disk(path: &str) -> String {
    respell(path, SPELLED_ARTIFACTS, ARTIFACTS)
}

/// A path on disk as a fixture spells it.
fn in_fixture(path: &str) -> String {
    respell(path, ARTIFACTS, SPELLED_ARTIFACTS)
}

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
            let metadata = std::fs::symlink_metadata(&path).expect("the entry exists");
            let found = if metadata.is_symlink() {
                Entry::Link(std::fs::read_link(&path).expect("the link is readable"))
            } else if metadata.is_dir() {
                pending.push(path);
                Entry::Dir
            } else {
                Entry::File(std::fs::read(&path).expect("the file is readable"))
            };
            entries.insert(relative, found);
        }
    }
    entries
}

/// What a run did to a tree.
#[derive(Debug, Default)]
struct Diff {
    /// Files created or changed, with their bytes.
    files: BTreeMap<String, Vec<u8>>,
    /// Directories created.
    dirs: Vec<String>,
    /// Entries gone after the run, in path order.
    removed: Vec<String>,
}

impl Diff {
    fn is_empty(&self) -> bool {
        self.files.is_empty() && self.dirs.is_empty() && self.removed.is_empty()
    }
}

fn diff(before: &Tree, after: &Tree) -> Diff {
    let mut changes = Diff::default();
    for (path, entry) in after {
        if before.get(path) == Some(entry) {
            continue;
        }
        match entry {
            Entry::File(bytes) => {
                changes.files.insert(path.clone(), bytes.clone());
            }
            Entry::Dir => changes.dirs.push(path.clone()),
            Entry::Link(_) => panic!("{path}: compact-mock never creates a link"),
        }
    }
    changes.removed = before
        .keys()
        .filter(|path| !after.contains_key(*path))
        .cloned()
        .collect();
    changes
}

fn assert_unchanged(label: &str, before: &Tree, after: &Tree) {
    let changes = diff(before, after);
    assert!(
        changes.is_empty(),
        "{label}: the tree changed: wrote {:?}, created {:?}, removed {:?}",
        changes.files.keys().collect::<Vec<_>>(),
        changes.dirs,
        changes.removed
    );
}

fn confined(path: &str) -> bool {
    path.split('/').any(|segment| segment == ARTIFACTS)
}

/// Every file written and every entry removed lies under an artifacts directory. A
/// created directory is one, lies under one, or leads to one.
fn assert_confined(label: &str, changes: &Diff) {
    for path in changes.files.keys().chain(&changes.removed) {
        assert!(
            confined(path),
            "{label}: {path} lies outside every artifacts directory"
        );
    }
    for dir in &changes.dirs {
        let leads = changes
            .files
            .keys()
            .any(|file| file.starts_with(&format!("{dir}/")) && confined(file));
        assert!(
            confined(dir) || leads,
            "{label}: created directory {dir} holds no artifacts directory"
        );
    }
}

/// A fresh temporary directory holding a copy of a case's inputs.
fn workspace(name: &str) -> TempDir {
    let directory = TempDir::new().expect("a temporary directory");
    for (relative, entry) in tree(&case(name)) {
        let first = relative.split('/').next().unwrap_or_default();
        if NOT_INPUTS.contains(&first) {
            continue;
        }
        let Entry::File(bytes) = entry else {
            continue;
        };
        let target = directory.path().join(on_disk(&relative));
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
    /// The exit code and both streams, then the removed paths when there are any.
    fn transcript(&self, removed: &[String]) -> String {
        let mut text = format!(
            "exit: {}\n--- stdout\n{}--- stderr\n{}",
            self.code, self.stdout, self.stderr
        );
        if !removed.is_empty() {
            text.push_str("--- removed\n");
            for path in removed {
                text.push_str(path);
                text.push('\n');
            }
        }
        text
    }
}

/// Runs the binary with `args` and `env` in `directory`. The directory's path prints as
/// [`ROOT`].
fn run_env(directory: &Path, args: &[&str], env: &[(&str, &str)]) -> Outcome {
    let mut command = Command::cargo_bin("compact-mock").expect("the binary is built");
    command.current_dir(directory).args(args);
    for name in SCRUBBED {
        command.env_remove(name);
    }
    command.envs(env.iter().copied());
    let output = command.output().expect("the binary ran");
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

fn run(directory: &Path, args: &[&str]) -> Outcome {
    run_env(directory, args, &[])
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

/// The files under `expected/<run>/`, keyed by their path on disk.
fn expected_files(name: &str, run: &str) -> BTreeMap<String, Vec<u8>> {
    tree(&case(name).join(EXPECTED).join(run))
        .into_iter()
        .filter_map(|(path, entry)| match entry {
            Entry::File(bytes) => Some((on_disk(&path), bytes)),
            _ => None,
        })
        .collect()
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
            let target = directory.join(in_fixture(relative));
            std::fs::create_dir_all(target.parent().expect("a parent")).expect("dirs");
            std::fs::write(target, bytes).expect("the expectation is writable");
        }
        return;
    }
    let expected = expected_files(name, run);
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

/// [`assert_run_with`] on the case's inputs as they are.
fn assert_run(name: &str, run_name: &str, args: &[&str]) -> TempDir {
    assert_run_with(name, run_name, args, |_| {})
}

/// Runs `generate <args>` on a fresh copy of a case, after `setup` edits it, and compares
/// the transcript and every file the run created or changed with `expected/<run>`.
///
/// Every write and removal lies under an artifacts directory. A failed run leaves the
/// tree exactly as it found it, directories included. After a successful run a second
/// run prints only `unchanged` lines and changes nothing.
fn assert_run_with(
    name: &str,
    run_name: &str,
    args: &[&str],
    setup: impl FnOnce(&Path),
) -> TempDir {
    let label = format!("{name}/{run_name}");
    let directory = workspace(name);
    setup(directory.path());
    let before = tree(directory.path());
    let outcome = run(directory.path(), &generate(args));
    let after = tree(directory.path());
    let changes = diff(&before, &after);
    assert_transcript(name, run_name, &outcome.transcript(&changes.removed));
    assert_files(name, run_name, &changes.files);
    assert_confined(&label, &changes);
    if outcome.code != 0 {
        assert_unchanged(&format!("{label}: a failed run"), &before, &after);
        return directory;
    }

    let again = run(directory.path(), &generate(args));
    assert_eq!(again.code, 0, "{label}: rerun\n{}", again.stderr);
    assert!(
        again
            .stdout
            .lines()
            .all(|line| line.starts_with("unchanged ")),
        "{label}: rerun wrote or removed\n{}",
        again.stdout
    );
    assert!(
        again.stderr.contains(" 0 written, ") && again.stderr.contains(" 0 removed."),
        "{label}: rerun\n{}",
        again.stderr
    );
    assert_unchanged(
        &format!("{label}: the rerun"),
        &after,
        &tree(directory.path()),
    );
    directory
}

/// `--config <run>.toml` followed by `extra`.
fn config_args<'a>(file: &'a str, extra: &[&'a str]) -> Vec<&'a str> {
    let mut args = vec!["--config", file];
    args.extend_from_slice(extra);
    args
}

/// [`assert_run`] with `--config <run>.toml` and any extra arguments.
fn assert_config(name: &str, run_name: &str, extra: &[&str]) -> TempDir {
    let file = format!("{run_name}.toml");
    assert_run(name, run_name, &config_args(&file, extra))
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

/// The blessed text of a generated file, by its path on disk.
fn expected(name: &str, run: &str, relative: &str) -> String {
    let path = case(name)
        .join(EXPECTED)
        .join(run)
        .join(in_fixture(relative));
    std::fs::read_to_string(&path).unwrap_or_else(|_| panic!("{} is missing", path.display()))
}

mod ownable_pair {
    use super::{assert_run, expected, read};

    const CASE: &str = "ownable-pair";
    const OUT: &str = "src/access/test/artifacts";

    #[test]
    fn the_ownable_pair_renders_the_authenticated_and_caller_mocks() {
        assert_run(CASE, "default", &[]);
    }

    #[test]
    fn without_caller_type_the_module_gets_one_mock_that_keeps_its_caller_parameters() {
        let directory = assert_run(CASE, "no-auth", &["--config", "no-auth.toml"]);
        let single = read(&directory, &format!("{OUT}/MockOwnable.compact"));
        let caller = expected(CASE, "default", &format!("{OUT}/MockOwnableCaller.compact"));
        assert_eq!(single, caller);
        assert!(!single.contains("AuthPrfPseudonym"));
    }

    #[test]
    fn ledger_false_drops_the_ledger_exports_and_a_caller_table_restores_them() {
        assert_run(CASE, "ledger", &["--config", "ledger.toml"]);
    }
}

mod rules {
    use super::{assert_config, edit, generate, read, run, tree};

    const CASE: &str = "rules";
    const MOCK: &str = "src/calc/test/artifacts/MockCalc.compact";

    #[test]
    fn disclose_wraps_the_forwarded_call_and_keeps_pure() {
        let directory = assert_config(CASE, "disclose", &[]);
        assert_eq!(read(&directory, MOCK).matches("disclose(").count(), 2);
    }

    #[test]
    fn disclose_on_a_unit_circuit_or_on_a_name_no_module_exports_is_an_error() {
        assert_config(CASE, "disclose-errors", &[]);
    }

    #[test]
    fn guard_true_wraps_every_exposed_circuit_and_drops_pure() {
        assert_config(CASE, "guard-all", &[]);
    }

    #[test]
    fn a_guard_list_wraps_only_the_listed_circuits() {
        assert_config(CASE, "guard-list", &[]);
    }

    #[test]
    fn rename_exposes_a_circuit_under_its_new_name_only() {
        assert_config(CASE, "rename", &[]);
    }

    #[test]
    fn a_clashing_rename_target_is_an_error_and_a_rename_of_an_excluded_circuit_is_skipped() {
        assert_config(CASE, "rename-errors", &[]);
    }

    #[test]
    fn exclude_leaves_circuits_out_of_the_mock() {
        assert_config(CASE, "exclude", &[]);
    }

    #[test]
    fn a_conventional_or_named_fragment_is_included_relative_to_the_artifacts_directory() {
        assert_config(CASE, "include", &[]);
    }

    #[test]
    fn a_missing_named_fragment_a_broken_fragment_and_a_fragment_constructor_are_errors() {
        assert_config(CASE, "include-errors", &[]);
    }

    #[test]
    fn editing_a_fragment_never_rewrites_the_mock() {
        let directory = assert_config(CASE, "include", &[]);
        let fragment = "src/calc/test/MockCalcFragment.fragment.compact";
        edit(&directory, fragment, |text| {
            format!("{text}\nexport circuit extra(): [] {{\n}}\n")
        });
        let before = tree(directory.path());
        let outcome = run(directory.path(), &generate(&["--config", "include.toml"]));
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        assert!(
            outcome
                .stdout
                .lines()
                .all(|line| line.starts_with("unchanged ")),
            "{}",
            outcome.stdout
        );
        assert_eq!(tree(directory.path()), before);
    }

    #[test]
    fn an_overloaded_initialize_under_the_constructor_is_an_error() {
        assert_config(CASE, "init-overload", &[]);
    }

    #[test]
    fn a_guarded_circuit_with_a_parameter_named_invocations_is_an_error() {
        assert_config(CASE, "guard-shadow", &[]);
    }

    #[test]
    fn init_flag_gates_initialize_and_takes_the_last_parameter() {
        assert_config(CASE, "init", &[]);
    }

    #[test]
    fn an_explicit_init_on_a_rule_without_initialize_and_a_clashing_flag_are_errors() {
        assert_config(CASE, "init-errors", &[]);
    }

    #[test]
    fn every_error_of_a_run_prints_in_order_and_nothing_is_written() {
        assert_config(CASE, "errors-batch", &[]);
    }

    #[test]
    fn a_mock_lands_in_the_artifacts_directory_with_its_stamp() {
        let directory = assert_config(CASE, "exclude", &[]);
        assert_eq!(
            read(&directory, "src/calc/test/artifacts/.compact-mock-stamp"),
            "# compact-mock owns this directory. It deletes the mocks listed here once no rule produces them.\nMockCalc\n"
        );
    }
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
    fn the_key_order_of_a_rule_does_not_change_the_output() {
        let first = assert_config(CASE, "circuit-generics", &[]);
        let second = workspace(CASE);
        let outcome = run(
            second.path(),
            &["generate", "--config", "circuit-generics-reordered.toml"],
        );
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        let mock = "src/pick/test/artifacts/MockPick.compact";
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
    fn a_type_the_module_export_list_names_is_nameable_by_a_wrapper() {
        assert_config(CASE, "export-list-type", &[]);
    }
}

mod auth_layer {
    use super::{TempDir, assert_config, assert_run, edit, generate, read, run};

    const CASE: &str = "auth-layer";
    const OUT: &str = "src/door/test/artifacts";

    fn mock(directory: &TempDir, name: &str) -> String {
        read(directory, &format!("{OUT}/{name}.compact"))
    }

    #[test]
    fn caller_parameters_match_by_declaration_through_every_import_form() {
        let directory = assert_config(CASE, "caller-matching", &[]);
        for name in [
            "MockDoorCaller",
            "MockPlainCaller",
            "MockTwin",
            "MockLobbyCaller",
        ] {
            let text = mock(&directory, name);
            assert!(!text.contains("auth/Gate"), "{name}");
            assert!(!text.contains("Gate_authenticate("), "{name}");
        }
        for (name, calls) in [("MockDoor", 4), ("MockLobby", 2)] {
            let text = mock(&directory, name);
            let call = format!("Gate_authenticate(pad(32, \"{name}\"))");
            assert_eq!(text.matches(&call).count(), calls, "{name}");
            assert!(!text.contains("Badge"), "{name}");
        }
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
    fn per_authenticator_tables_replace_rule_keys_and_the_salt_follows_the_table() {
        assert_config(CASE, "per-auth", &[]);
    }

    #[test]
    fn a_salt_change_rewrites_the_authenticated_mock_only() {
        let directory = assert_config(CASE, "per-auth", &[]);
        let calls = mock(&directory, "MockEntry").matches("front door").count();
        edit(&directory, "per-auth.toml", |text| {
            text.replace("\"front door\"", "\"back door\"")
        });
        let outcome = run(directory.path(), &generate(&["--config", "per-auth.toml"]));
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        let wrote: Vec<&str> = outcome
            .stdout
            .lines()
            .filter(|line| !line.starts_with("unchanged "))
            .collect();
        assert_eq!(wrote, [format!("wrote {OUT}/MockEntry.compact")]);
        assert_eq!(
            mock(&directory, "MockEntry").matches("back door").count(),
            calls
        );
    }

    #[test]
    fn a_caller_inside_a_compound_type_a_struct_or_a_nominal_alias_is_an_error() {
        assert_config(CASE, "contains-caller", &[]);
    }

    #[test]
    fn two_caller_parameters_of_one_circuit_or_initialize_are_an_error_when_authenticated() {
        assert_config(CASE, "caller-twice", &[]);
    }

    #[test]
    fn a_caller_typed_parameter_not_named_in_params_stays_a_circuit_argument() {
        let directory = assert_config(CASE, "caller-named", &[]);
        let text = mock(&directory, "MockPair");
        assert!(
            text.contains("export circuit swap(target: Badge): [] {"),
            "{text}"
        );
        assert!(
            text.contains("constructor(keeper: Badge, heir: Badge) {"),
            "{text}"
        );
    }

    #[test]
    fn a_module_or_circuit_argument_that_is_or_holds_the_caller_type_is_an_error_in_every_mock() {
        assert_config(CASE, "caller-argument", &[]);
    }

    #[test]
    fn an_authenticator_circuit_exported_through_an_export_list_is_called() {
        let directory = assert_config(CASE, "auth-listed", &[]);
        assert!(
            mock(&directory, "MockHinge").contains("Listed_authenticate(pad(32, \"MockHinge\"))")
        );
    }

    #[test]
    fn an_interface_circuit_whose_caller_the_wrapper_injects_is_an_error() {
        assert_config(CASE, "implements-caller", &[]);
    }

    #[test]
    fn an_interface_set_on_the_caller_mock_only_is_implemented() {
        let directory = assert_config(CASE, "implements-per-auth", &[]);
        assert!(mock(&directory, "MockDoorCaller").contains("contract implements Opener;"));
        assert!(!mock(&directory, "MockDoor").contains("implements"));
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
    fn a_long_empty_quoted_escaped_or_control_salt_is_an_error_and_an_unused_salt_is_not() {
        assert_config(CASE, "salt-errors", &[]);
    }

    #[test]
    fn selected_names_print_in_expansion_order_once() {
        assert_run(
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
    fn an_unknown_name_or_a_name_its_rule_leaves_out_is_an_error() {
        assert_run(
            CASE,
            "name-filter-unknown",
            &["--config", "expansion.toml", "MockNope"],
        );
        assert_run(
            CASE,
            "name-filter-left-out",
            &["--config", "per-auth.toml", "MockHinge"],
        );
    }

    #[test]
    fn an_expansion_error_of_an_unselected_mock_still_fails_the_run() {
        assert_config(CASE, "name-filter-broken", &["MockHinge"]);
    }

    #[test]
    fn a_plan_error_of_an_unselected_mock_is_not_reported() {
        assert_config(CASE, "name-filter-unselected", &["MockHinge"]);
    }

    #[test]
    fn the_source_tree_never_names_a_compact_contracts_auth_path() {
        let mut pending = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")];
        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(directory).expect("src is readable") {
                let path = entry.expect("the entry is readable").path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                let text = std::fs::read_to_string(&path).expect("the source is readable");
                for name in ["AuthPrfPseudonym", "identifier/Identifier"] {
                    assert!(!text.contains(name), "{} names {name}", path.display());
                }
            }
        }
    }
}

mod rebase {
    use super::{assert_config, assert_run};

    const CASE: &str = "rebase";

    #[test]
    fn import_paths_are_rebased_from_each_artifacts_directory() {
        assert_run(CASE, "default", &[]);
    }

    #[test]
    fn a_nested_test_dir_moves_the_artifacts_directory_and_its_import_paths() {
        assert_config(CASE, "test-dir", &[]);
    }
}

mod globs {
    use super::{assert_run, read};

    const CASE: &str = "globs";

    #[test]
    fn rules_fold_in_file_order_a_per_authenticator_table_applies_last_and_skips_print() {
        let directory = assert_run(CASE, "default", &[]);
        let paused = read(
            &directory,
            "src/access/extensions/test/artifacts/MockPausedCaller.compact",
        );
        assert!(!paused.contains("Gate"), "{paused}");
    }
}

mod authenticators {
    use super::{assert_config, read};

    const CASE: &str = "authenticators";
    const OUT: &str = "src/access/test/artifacts";

    #[test]
    fn each_named_authenticator_gets_a_mock_and_a_call_without_a_salt_slot_ignores_salt() {
        let directory = assert_config(CASE, "multi-auth", &[]);
        let ecdsa = read(&directory, &format!("{OUT}/MockOwnedEcdsa.compact"));
        assert!(ecdsa.contains("Ecdsa_authenticateForThisContract()"));
        assert!(!ecdsa.contains("owned"));
    }

    #[test]
    fn an_injector_fills_its_type_next_to_an_injected_caller_or_everywhere_with_scope_all() {
        let directory = assert_config(CASE, "inject", &[]);
        let caller = read(&directory, &format!("{OUT}/MockShieldedCaller.compact"));
        assert!(!caller.contains("Blind_read()"), "{caller}");
        let all = read(&directory, &format!("{OUT}/MockOpenCaller.compact"));
        assert!(all.contains("Blind_read()"), "{all}");
    }

    #[test]
    fn an_injector_fills_only_parameters_its_params_name() {
        let directory = assert_config(CASE, "inject-named", &[]);
        for name in ["MockOpen", "MockOpenCaller"] {
            let text = read(&directory, &format!("{OUT}/{name}.compact"));
            assert!(!text.contains("Blind_read()"), "{name}: {text}");
        }
    }

    #[test]
    fn a_ledger_or_expression_salt_with_a_caller_in_initialize_is_an_error() {
        assert_config(CASE, "salt-before-init", &[]);
    }

    #[test]
    fn a_ledger_salt_replaces_the_whole_slot_with_the_prefixed_field() {
        let directory = assert_config(CASE, "salt-ledger", &[]);
        let vault = read(&directory, &format!("{OUT}/MockVault.compact"));
        assert!(
            vault.contains("Prf_authenticate(Vault__instanceSalt)"),
            "{vault}"
        );
    }

    #[test]
    fn plain_ledger_names_import_the_listed_fields_by_name_and_export_them_bare() {
        assert_config(CASE, "ledger-plain", &[]);
    }

    #[test]
    fn an_expression_salt_replaces_the_whole_slot_verbatim() {
        let directory = assert_config(CASE, "salt-expr", &[]);
        let vault = read(&directory, &format!("{OUT}/MockVault.compact"));
        assert!(
            vault.contains("Prf_authenticate(pad(32, \"fixed\"))"),
            "{vault}"
        );
    }
}

mod instances {
    use super::assert_config;

    const CASE: &str = "instances";

    #[test]
    fn each_stand_alone_instance_is_its_own_mock_with_its_own_keys() {
        assert_config(CASE, "instances", &[]);
    }

    #[test]
    fn a_merged_group_wraps_every_instance_and_shares_one_constructor() {
        assert_config(CASE, "merge", &[]);
    }

    #[test]
    fn merged_instances_whose_numeric_arguments_share_a_value_are_an_error() {
        assert_config(CASE, "same-value", &[]);
    }
}

mod overload {
    use super::assert_run;

    #[test]
    fn every_overload_gets_a_wrapper_named_by_position_or_by_its_signature_rename() {
        assert_run("overload", "default", &[]);
    }
}

mod export_list_wrapper {
    use super::assert_run;

    #[test]
    fn a_wrapped_export_list_circuit_is_respelled_from_its_declaring_file() {
        assert_run("export-list-wrapper", "default", &[]);
    }
}

mod implements {
    use super::{assert_config, assert_run, read};

    const CASE: &str = "implements";

    #[test]
    fn an_interface_met_by_re_exports_and_a_fragment_circuit_is_implemented() {
        let directory = assert_run(CASE, "default", &[]);
        let mock = read(&directory, "src/count/test/artifacts/MockCount.compact");
        assert!(mock.contains("export circuit readOther(other: Tally): Uint<64> {"));
        assert!(!mock.contains("export { Tally"), "{mock}");
    }

    #[test]
    fn an_interface_circuit_no_mock_exposes_is_an_error_naming_the_fragment() {
        assert_config(CASE, "implements-missing", &[]);
    }
}

mod witness_clash {
    use super::{assert_config, assert_run};

    const CASE: &str = "witness-clash";

    #[test]
    fn two_witnesses_of_one_name_from_two_files_are_an_error() {
        assert_run(CASE, "default", &[]);
    }

    #[test]
    fn one_witness_reached_twice_is_allowed() {
        assert_config(CASE, "diamond", &[]);
    }

    #[test]
    fn a_fragment_witness_named_like_an_imported_one_is_an_error() {
        assert_config(CASE, "fragment", &[]);
    }
}

mod generic_glob {
    use super::{assert_config, assert_run, read};

    const CASE: &str = "generic-glob";

    #[test]
    fn a_glob_skips_a_generic_module_or_circuit_without_arguments_and_succeeds() {
        let directory = assert_run(CASE, "default", &[]);
        let text = read(&directory, "src/math/test/artifacts/MockBox.compact");
        assert!(!text.contains("wrap"), "{text}");
    }

    #[test]
    fn an_exact_module_path_keeps_the_errors() {
        assert_config(CASE, "exact", &[]);
    }
}

mod fragment_import {
    use super::assert_run;

    #[test]
    fn a_fragment_with_its_own_import_is_included_beside_the_module_prefix_import() {
        assert_run("fragment-import", "default", &[]);
    }
}

#[cfg(unix)]
mod ownership {
    use std::path::Path;

    use super::{
        TempDir, assert_config, assert_run, assert_run_with, assert_transcript, assert_unchanged,
        generate, run, tree, workspace,
    };

    const CASE: &str = "ownership";
    const OUT: &str = "src/lib/test/artifacts";

    #[test]
    fn a_stale_listed_mock_and_an_emptied_directory_are_removed_and_unlisted_files_stay() {
        let directory = assert_run(CASE, "stale", &[]);
        assert!(directory.path().join(OUT).join("keep.txt").is_file());
        assert!(directory.path().join("src/lib/test/x.compact").is_file());
        assert!(!directory.path().join("src/old/test/artifacts").exists());
    }

    #[test]
    fn dir_limits_stale_removal_to_the_stamped_directories_under_it() {
        let directory = assert_run(CASE, "dir-scope", &["--dir", "src/lib"]);
        assert!(
            directory
                .path()
                .join("src/old/test/artifacts/MockOld.compact")
                .is_file()
        );
    }

    #[test]
    fn a_name_argument_keeps_every_stale_mock_and_its_stamp_line() {
        assert_run(CASE, "name-keeps", &["MockLib"]);
    }

    #[test]
    fn a_stale_symlink_is_kept_and_reported_and_its_target_stays() {
        let directory = assert_run_with(CASE, "symlink", &[], |root| {
            let outside = root.join("outside");
            std::fs::create_dir_all(&outside).expect("the target is created");
            std::fs::write(outside.join("keep.txt"), "a link target\n").expect("written");
            let gone = root.join(OUT).join("MockGone");
            std::fs::remove_dir_all(&gone).expect("the stale directory is replaced");
            std::os::unix::fs::symlink(&outside, &gone).expect("the link is created");
        });
        assert!(directory.path().join("outside/keep.txt").is_file());
        assert!(std::fs::symlink_metadata(directory.path().join(OUT).join("MockGone")).is_ok());
    }

    #[test]
    fn a_stale_entry_without_the_header_or_compiled_output_is_kept_and_reported() {
        let directory = assert_run_with(CASE, "stale-foreign", &[], |root| {
            let out = root.join(OUT);
            std::fs::write(out.join("MockGone.compact"), "// hand-written\n").expect("written");
            std::fs::write(out.join("MockGone/notes.txt"), "mine\n").expect("written");
        });
        assert!(
            directory
                .path()
                .join(OUT)
                .join("MockGone.compact")
                .is_file()
        );
        assert!(
            directory
                .path()
                .join(OUT)
                .join("MockGone/notes.txt")
                .is_file()
        );
    }

    #[test]
    fn a_stale_mock_with_an_spdx_line_above_the_header_is_removed() {
        let directory = assert_run_with(CASE, "stale-spdx", &[], |root| {
            std::fs::write(
                root.join("compact.toml"),
                "[mock]\nspdx = \"MIT\"\n\n[[mock.rules]]\nmodules = [\"lib/Lib\"]\n",
            )
            .expect("written");
            std::fs::write(
                root.join(OUT).join("MockGone.compact"),
                "// SPDX-License-Identifier: MIT\n// Generated by compact-mock from lib/Gone. Do not edit by hand.\n",
            )
            .expect("written");
        });
        assert!(!directory.path().join(OUT).join("MockGone.compact").exists());
    }

    #[test]
    fn a_stamp_outside_an_artifacts_directory_deletes_nothing_and_is_reported() {
        let directory = assert_run_with(CASE, "stray-stamp", &[], |root| {
            let stamp = "# compact-mock owns this directory.\nLib\nlib\n";
            std::fs::write(root.join("src/lib/.compact-mock-stamp"), stamp).expect("written");
            std::fs::write(root.join("src/.compact-mock-stamp"), stamp).expect("written");
        });
        assert!(directory.path().join("src/lib/Lib.compact").is_file());
    }

    #[test]
    fn an_unlisted_file_without_the_header_is_never_overwritten() {
        assert_run_with(CASE, "unlisted", &[], |root| {
            let out = root.join(OUT);
            std::fs::write(out.join("MockLib.compact"), "// hand-written\n").expect("written");
            std::fs::write(
                out.join(".compact-mock-stamp"),
                "# compact-mock owns this directory.\nMockGone\n",
            )
            .expect("written");
        });
    }

    #[test]
    fn a_symlinked_directory_above_the_artifacts_directory_is_refused() {
        assert_run_with(CASE, "linked-parent", &[], |root: &Path| {
            let test = root.join("src/lib/test");
            let elsewhere = root.join("elsewhere");
            std::fs::rename(&test, &elsewhere).expect("the directory moves");
            std::os::unix::fs::symlink(&elsewhere, &test).expect("the link is created");
        });
    }

    #[test]
    fn a_rename_that_changes_only_case_never_deletes_the_new_spelling() {
        let directory = assert_run_with(CASE, "case-rename", &[], |root| {
            std::fs::write(
                root.join("compact.toml"),
                "[[mock.rules]]\nmodules = [\"lib/Lib\"]\nname = \"MockLIB\"\n",
            )
            .expect("written");
            std::fs::write(
                root.join(OUT).join("MockLib.compact"),
                "// Generated by compact-mock from lib/Lib. Do not edit by hand.\n",
            )
            .expect("written");
        });
        assert!(directory.path().join(OUT).join("MockLib.compact").is_file());
    }

    /// Runs `generate <args>` once after `setup`, compares the transcript, and checks the
    /// tree did not change.
    fn assert_untouched(run_name: &str, args: &[&str], setup: impl FnOnce(&Path)) {
        let directory = workspace(CASE);
        setup(directory.path());
        let before = tree(directory.path());
        let outcome = run(directory.path(), &generate(args));
        assert_transcript(CASE, run_name, &outcome.transcript(&[]));
        assert_unchanged(run_name, &before, &tree(directory.path()));
    }

    #[test]
    fn dir_outside_src_writes_nothing_and_succeeds_with_a_note() {
        assert_untouched("dir-outside", &["--dir", "elsewhere"], |root| {
            std::fs::create_dir(root.join("elsewhere")).expect("created");
        });
    }

    #[test]
    fn dir_through_a_symlink_writes_nothing_and_succeeds_with_a_note() {
        assert_untouched("dir-linked", &["--dir", "link/lib"], |root| {
            std::os::unix::fs::symlink(root.join("src"), root.join("link")).expect("linked");
        });
    }

    #[test]
    fn dir_through_a_symlink_below_src_writes_nothing_and_succeeds_with_a_note() {
        assert_untouched("dir-linked-below", &["--dir", "src/alias"], |root| {
            std::os::unix::fs::symlink(root.join("src/lib"), root.join("src/alias"))
                .expect("linked");
        });
    }

    #[test]
    fn dir_above_src_keeps_working() {
        assert_run(CASE, "dir-above", &["--dir", "."]);
    }

    #[test]
    fn a_symlinked_working_directory_does_not_trip_the_symlink_check() {
        let directory = workspace(CASE);
        let holder = TempDir::new().expect("a temporary directory");
        let linked = holder.path().join("workspace");
        std::os::unix::fs::symlink(directory.path(), &linked).expect("linked");
        let outcome = run(&linked, &generate(&["--dir", "src/lib"]));
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        assert!(
            outcome
                .stdout
                .contains("wrote src/lib/test/artifacts/MockLib.compact"),
            "{}",
            outcome.stdout
        );
    }

    #[test]
    fn a_file_named_twice_compact_is_its_own_module() {
        assert_run_with(CASE, "double-suffix", &[], |root| {
            std::fs::copy(
                root.join("src/lib/Lib.compact"),
                root.join("src/lib/Lib.compact.compact"),
            )
            .expect("copied");
        });
    }

    #[test]
    fn an_exclude_pattern_that_excludes_nothing_is_reported() {
        assert_config(CASE, "exclude-unused", &[]);
    }

    #[test]
    fn src_outside_the_config_directory_is_an_error() {
        assert_config(CASE, "src-outside", &[]);
    }

    #[test]
    fn only_keeps_the_mocks_a_file_glob_matches_and_deletes_nothing() {
        let directory = assert_run(CASE, "only", &["--only", "Lib.compact"]);
        assert!(
            directory
                .path()
                .join(OUT)
                .join("MockGone.compact")
                .is_file()
        );
        assert_run(CASE, "only-none", &["--only", "Nope.compact"]);
    }

    #[test]
    fn a_directory_with_files_and_no_stamp_is_refused_and_nothing_is_written() {
        assert_run_with(CASE, "foreign", &[], |root| {
            std::fs::remove_file(root.join(OUT).join(".compact-mock-stamp"))
                .expect("the stamp is removed");
        });
    }

    #[test]
    fn an_empty_artifacts_directory_is_adopted() {
        assert_run_with(CASE, "empty", &[], |root| {
            let out = root.join(OUT);
            std::fs::remove_dir_all(&out).expect("the directory is emptied");
            std::fs::create_dir(&out).expect("the directory is recreated");
        });
    }

    #[test]
    fn a_symlinked_artifacts_directory_is_refused() {
        assert_run_with(CASE, "linked-dir", &[], |root: &Path| {
            let out = root.join(OUT);
            let elsewhere = root.join("elsewhere");
            std::fs::rename(&out, &elsewhere).expect("the directory moves");
            std::os::unix::fs::symlink(&elsewhere, &out).expect("the link is created");
        });
    }
}

mod selection {
    use super::{assert_config, assert_run, config_args};

    const CASE: &str = "selection";

    #[test]
    fn mocks_named_alike_in_two_directories_are_an_error_with_a_name_hint() {
        assert_config(CASE, "name-dup", &[]);
    }

    #[test]
    fn the_dir_placeholder_names_mocks_apart() {
        assert_config(CASE, "name-dir", &[]);
    }

    #[test]
    fn dir_with_no_module_under_it_is_a_successful_run_with_zero_mocks() {
        assert_run(
            CASE,
            "zero-mocks",
            &config_args("name-dir.toml", &["--dir", "src/notes"]),
        );
    }

    #[test]
    fn dir_tolerates_a_failing_module_outside_it() {
        assert_run(
            CASE,
            "dir-override",
            &config_args("dir-override.toml", &["--dir", "src/access"]),
        );
    }

    #[test]
    fn without_dir_the_failing_module_fails_the_run() {
        assert_run(
            CASE,
            "dir-override-all",
            &config_args("dir-override.toml", &[]),
        );
    }

    #[test]
    fn dir_never_hides_a_config_level_error() {
        assert_run(
            CASE,
            "dir-override-config",
            &config_args("dir-override-config.toml", &["--dir", "src/access"]),
        );
    }
}

#[cfg(unix)]
mod build {
    use std::os::unix::fs::PermissionsExt;

    use super::{
        Outcome, TempDir, assert_confined, assert_files, assert_transcript, assert_unchanged, diff,
        run_env, tree, workspace,
    };

    const CASE: &str = "toolchain";

    /// A stand-in for `compact`. It appends its arguments to `argv.txt` beside it, exits 3
    /// when its input path contains `Fail`, and otherwise prints a warning to stderr and
    /// writes `<out>/contract/index.js`.
    struct Stub {
        directory: TempDir,
    }

    impl Stub {
        fn new() -> Self {
            let directory = TempDir::new().expect("a temporary directory");
            let log = directory.path().join("argv.txt");
            let script = format!(
                "#!/bin/sh\n\
                 printf '%s\\n' \"$*\" >> '{}'\n\
                 for arg in \"$@\"; do input=\"$out\"; out=\"$arg\"; done\n\
                 case \"$input\" in *Fail*) echo \"stub: cannot compile $input\" >&2; exit 3 ;; esac\n\
                 echo \"stub: warning: $input compiled with a warning\" >&2\n\
                 echo \"Compiling 1 circuit\"\n\
                 mkdir -p \"$out/contract\"\n\
                 echo 'export {{}};' > \"$out/contract/index.js\"\n",
                log.display()
            );
            let bin = directory.path().join("compact");
            std::fs::write(&bin, script).expect("the stub is written");
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))
                .expect("the stub is executable");
            Self { directory }
        }

        fn bin(&self) -> String {
            self.directory.path().join("compact").display().to_string()
        }

        /// Each call's arguments, joined by spaces.
        fn calls(&self) -> Vec<String> {
            std::fs::read_to_string(self.directory.path().join("argv.txt"))
                .map(|text| text.lines().map(str::to_owned).collect())
                .unwrap_or_default()
        }
    }

    /// Runs `build <args>` with `env` on a fresh copy of the case and compares the
    /// transcript, the stub's calls and the files written with `expected/<run>`. A run that
    /// fails before compiling leaves the tree as it found it.
    fn assert_build(run_name: &str, args: &[&str], env: &[(&str, &str)], stub: &Stub) {
        let label = format!("{CASE}/{run_name}");
        let directory = workspace(CASE);
        let before = tree(directory.path());
        let mut command = vec!["build"];
        command.extend_from_slice(args);
        let outcome: Outcome = run_env(directory.path(), &command, env);
        let after = tree(directory.path());
        let changes = diff(&before, &after);
        let mut transcript = outcome.transcript(&changes.removed);
        transcript.push_str("--- compact calls\n");
        for call in stub.calls() {
            transcript.push_str(&call);
            transcript.push('\n');
        }
        assert_transcript(CASE, run_name, &transcript);
        assert_files(CASE, run_name, &changes.files);
        assert_confined(&label, &changes);
        if outcome.code == 2 && !outcome.stdout.contains("wrote ") {
            assert_unchanged(&label, &before, &after);
        }
    }

    #[test]
    fn each_mock_compiles_with_the_version_and_skip_zk_before_its_paths() {
        let stub = Stub::new();
        let bin = stub.bin();
        assert_build(
            "argv",
            &["+0.36.0", "--skip-zk", "MockAlpha", "--compact-bin", &bin],
            &[],
            &stub,
        );
    }

    #[test]
    fn skip_zk_true_in_the_environment_passes_skip_zk() {
        let stub = Stub::new();
        let bin = stub.bin();
        assert_build(
            "skip-zk-env",
            &["MockAlpha", "--compact-bin", &bin],
            &[("SKIP_ZK", "true")],
            &stub,
        );
    }

    #[test]
    fn skip_zk_other_than_true_passes_nothing() {
        let stub = Stub::new();
        let directory = workspace(CASE);
        let bin = stub.bin();
        let outcome = run_env(
            directory.path(),
            &["build", "MockAlpha", "--compact-bin", &bin],
            &[("SKIP_ZK", "1")],
        );
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        assert_eq!(
            stub.calls(),
            ["compile src/lib/test/artifacts/MockAlpha.compact src/lib/test/artifacts/MockAlpha"]
        );
    }

    #[test]
    fn two_versions_are_a_usage_error() {
        let stub = Stub::new();
        let bin = stub.bin();
        assert_build(
            "two-versions",
            &["+0.36.0", "+0.35.0", "--compact-bin", &bin],
            &[],
            &stub,
        );
    }

    #[test]
    fn the_first_failed_compile_stops_the_run_with_exit_one() {
        let stub = Stub::new();
        let bin = stub.bin();
        assert_build("first-failure", &["--compact-bin", &bin], &[], &stub);
    }

    #[test]
    fn a_compact_that_cannot_start_exits_two() {
        let stub = Stub::new();
        assert_build(
            "missing-binary",
            &["MockAlpha", "--compact-bin", "./no/compact"],
            &[],
            &stub,
        );
    }

    #[test]
    fn zero_mocks_compile_nothing_and_succeed() {
        let stub = Stub::new();
        let bin = stub.bin();
        assert_build(
            "zero-mocks",
            &["--dir", "src/notes", "--compact-bin", &bin],
            &[],
            &stub,
        );
    }

    #[test]
    fn a_generate_error_compiles_nothing() {
        let stub = Stub::new();
        let bin = stub.bin();
        assert_build(
            "unknown-name",
            &["MockNope", "--compact-bin", &bin],
            &[],
            &stub,
        );
    }

    #[test]
    fn arguments_after_the_separator_reach_every_compile_before_the_paths() {
        let stub = Stub::new();
        let bin = stub.bin();
        assert_build(
            "passthrough",
            &[
                "MockAlpha",
                "--compact-bin",
                &bin,
                "--",
                "--no-communications-commitment",
                "--compact-path",
                "vendor",
            ],
            &[],
            &stub,
        );
    }

    #[test]
    fn only_builds_the_mocks_a_file_glob_matches() {
        let stub = Stub::new();
        let bin = stub.bin();
        assert_build(
            "only",
            &["--only", "MockAlpha.compact", "--compact-bin", &bin],
            &[],
            &stub,
        );
    }

    #[test]
    fn the_compact_bin_variable_names_the_executable() {
        let stub = Stub::new();
        let bin = stub.bin();
        assert_build(
            "env-bin",
            &["MockAlpha"],
            &[("COMPACT_MOCK_COMPACT_BIN", &bin)],
            &stub,
        );
    }
}

mod closed_stdout {
    use std::process::{Command, Output, Stdio};

    use assert_cmd::prelude::*;

    use super::{SCRUBBED, TempDir, diff, tree, workspace};

    /// Runs `generate <args>` in `directory` with stdout a pipe whose reader is closed.
    fn run(directory: &TempDir, args: &[&str]) -> Output {
        let (reader, writer) = std::io::pipe().expect("a pipe");
        drop(reader);
        let mut command = Command::cargo_bin("compact-mock").expect("the binary is built");
        for name in SCRUBBED {
            command.env_remove(name);
        }
        command
            .current_dir(directory.path())
            .arg("generate")
            .args(args)
            .stdout(writer)
            .stderr(Stdio::piped())
            .output()
            .expect("the binary ran")
    }

    const FAILURE: &str = "compact-mock: cannot write to stdout\n  caused by: ";

    #[test]
    fn generate_writes_every_mock_and_stamp_before_reporting_the_failed_print() {
        let directory = workspace("rebase");
        let before = tree(directory.path());
        let output = run(&directory, &[]);
        let stderr = String::from_utf8(output.stderr).expect("stderr is UTF-8");
        assert_eq!(output.status.code(), Some(2), "{stderr}");
        assert!(stderr.starts_with(FAILURE), "{stderr}");
        assert_eq!(stderr.lines().count(), 2, "{stderr}");
        let written = diff(&before, &tree(directory.path())).files;
        assert_eq!(written.len(), 8, "{:?}", written.keys());
    }
}

mod determinism {
    use std::collections::BTreeMap;
    use std::path::Path;

    use super::{Entry, diff, expected_files, run, tree, workspace};

    /// Runs `generate <args>` from `cwd` (relative to a fresh copy of `name`) and returns
    /// the files it wrote.
    fn written(name: &str, cwd: &str, args: &[&str]) -> BTreeMap<String, Vec<u8>> {
        let directory = workspace(name);
        let before = tree(directory.path());
        let mut command = vec!["generate"];
        command.extend_from_slice(args);
        let outcome = run(&directory.path().join(cwd), &command);
        assert_eq!(outcome.code, 0, "{}", outcome.stderr);
        diff(&before, &tree(directory.path())).files
    }

    #[test]
    fn the_output_is_the_same_from_any_working_directory() {
        let from_root = written("rebase", ".", &[]);
        assert_eq!(from_root.len(), 8);
        assert_eq!(written("rebase", "src/near", &[]), from_root);
        assert_eq!(
            written("rebase", "src/far", &["--config", "../../compact.toml"]),
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
            for (path, entry) in tree(directory.path()) {
                let Entry::File(bytes) = entry else {
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
            let produced = diff(&before, &tree(directory.path())).files;
            assert_eq!(produced, expected_files(name, run_name), "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_write_prints_one_error_no_summary_and_leaves_no_temporary_file() {
        use std::os::unix::fs::PermissionsExt;

        let directory = workspace("rebase");
        let locked = directory.path().join("src/far/test");
        std::fs::create_dir_all(&locked).expect("the directory is created");
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555))
            .expect("the directory is locked");
        // A process that ignores directory permissions cannot reach this message.
        if std::fs::write(locked.join("probe"), "").is_ok() {
            return;
        }
        let outcome = run(directory.path(), &["generate"]);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755))
            .expect("the directory is unlocked");
        assert_eq!(outcome.code, 2);
        assert_eq!(outcome.stdout, "");
        let lines: Vec<&str> = outcome.stderr.lines().collect();
        assert_eq!(lines.len(), 2, "{}", outcome.stderr);
        assert_eq!(
            lines[0],
            "compact-mock: cannot write src/far/test/artifacts/.compact-mock-stamp"
        );
        assert!(lines[1].starts_with("  caused by: "));
        let after = tree(directory.path());
        assert!(
            after
                .keys()
                .all(|path| Path::new(path).extension().is_none_or(|ext| ext != "tmp")),
            "{after:?}"
        );
    }
}
