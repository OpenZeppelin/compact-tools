use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use super::{DirState, Produced, STAMP, Step, execute, inspect, parse_stamp, plan, render_stamp};
use crate::config::Paths;
use crate::error::OutputError;
use crate::output::Target;

fn names(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|name| (*name).to_owned()).collect()
}

fn stamp(dir: &Path, list: &[&str]) {
    std::fs::create_dir_all(dir).expect("dirs");
    std::fs::write(dir.join(STAMP), render_stamp(&names(list))).expect("written");
}

fn target(dir: &Path, name: &str) -> Target {
    Target {
        name: name.to_owned(),
        path: dir.join(format!("{name}.compact")),
        artifacts: dir.to_owned(),
        shown: format!("{name}.compact"),
        text: format!("// {name}\n"),
        existing: None,
    }
}

struct Case {
    directory: tempfile::TempDir,
    paths: Paths,
}

impl Case {
    fn new() -> Self {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        let paths = Paths {
            cwd: directory.path().to_owned(),
        };
        Self { directory, paths }
    }

    fn dir(&self, relative: &str) -> PathBuf {
        self.directory.path().join(relative)
    }

    fn produced(
        &self,
        written: &[(&str, &[&str])],
        expansion: &[(&str, &[&str])],
        examine: Option<&str>,
    ) -> Produced {
        let map = |list: &[(&str, &[&str])]| -> BTreeMap<PathBuf, BTreeSet<String>> {
            list.iter()
                .map(|(dir, list)| (self.dir(dir), names(list)))
                .collect()
        };
        Produced {
            written: map(written),
            expansion: map(expansion),
            unsure: BTreeSet::new(),
            examine: examine.map(|root| self.dir(root)),
        }
    }
}

#[test]
fn a_stamp_ignores_comments_blanks_and_non_identifiers() {
    assert_eq!(
        parse_stamp("# header\n\nMockA\n../x\nMock B\n  MockC  \n"),
        names(&["MockA", "MockC"])
    );
    assert_eq!(
        render_stamp(&names(&["MockB", "MockA"]))
            .lines()
            .skip(1)
            .collect::<Vec<_>>(),
        ["MockA", "MockB"]
    );
}

#[test]
fn a_missing_empty_or_stamped_directory_is_writable_and_anything_else_is_not() {
    let case = Case::new();
    assert_eq!(
        inspect(&case.dir("a"), &case.paths).expect("reads"),
        DirState::Missing
    );
    std::fs::create_dir_all(case.dir("b")).expect("dirs");
    assert_eq!(
        inspect(&case.dir("b"), &case.paths).expect("reads"),
        DirState::Empty
    );
    stamp(&case.dir("c"), &["MockC"]);
    assert_eq!(
        inspect(&case.dir("c"), &case.paths).expect("reads"),
        DirState::Stamped(names(&["MockC"]))
    );
    std::fs::create_dir_all(case.dir("d")).expect("dirs");
    std::fs::write(case.dir("d/notes.txt"), "x").expect("written");
    assert_eq!(
        inspect(&case.dir("d"), &case.paths).expect("reads"),
        DirState::Foreign
    );
    std::os::unix::fs::symlink(case.dir("c"), case.dir("e")).expect("linked");
    assert_eq!(
        inspect(&case.dir("e"), &case.paths).expect("reads"),
        DirState::Foreign
    );

    let produced = case.produced(&[("d", &["MockD"]), ("e", &["MockE"])], &[], None);
    let errors: Vec<String> = plan(&produced, &case.paths)
        .expect_err("refused")
        .iter()
        .map(ToString::to_string)
        .collect();
    assert_eq!(
        errors,
        [
            "d exists and has no .compact-mock-stamp; compact-mock writes only into directories it owns. Move it away or empty it",
            "e exists and has no .compact-mock-stamp; compact-mock writes only into directories it owns. Move it away or empty it",
        ]
    );
}

#[test]
fn only_listed_names_the_expansion_dropped_are_deleted() {
    let case = Case::new();
    let dir = case.dir("src/a/test/artifacts");
    stamp(&dir, &["MockKeep", "MockOld"]);
    for file in [
        "MockKeep.compact",
        "MockOld.compact",
        "keep.txt",
        "MockStray.compact",
    ] {
        std::fs::write(dir.join(file), "x").expect("written");
    }
    std::fs::create_dir_all(dir.join("MockOld/contract")).expect("dirs");
    let produced = case.produced(
        &[("src/a/test/artifacts", &["MockKeep"])],
        &[("src/a/test/artifacts", &["MockKeep"])],
        Some("src"),
    );
    let own = plan(&produced, &case.paths).expect("owned");
    assert_eq!(own.dirs.len(), 1);
    assert_eq!(
        own.dirs[0].stale,
        [dir.join("MockOld"), dir.join("MockOld.compact")]
    );
    let report = execute(&own, &[target(&dir, "MockKeep")], &case.paths, &mut |_| {
        Ok(())
    })
    .expect("runs");
    assert_eq!(
        report.removed,
        [
            "src/a/test/artifacts/MockOld",
            "src/a/test/artifacts/MockOld.compact"
        ]
    );
    assert!(dir.join("keep.txt").exists() && dir.join("MockStray.compact").exists());
    assert_eq!(
        parse_stamp(&std::fs::read_to_string(dir.join(STAMP)).expect("reads")),
        names(&["MockKeep"])
    );
}

#[test]
fn a_dir_scope_examines_only_stamped_directories_under_it() {
    let case = Case::new();
    let inside = case.dir("src/a/test/artifacts");
    let outside = case.dir("src/b/test/artifacts");
    stamp(&inside, &["MockA"]);
    stamp(&outside, &["MockGone"]);
    std::fs::write(outside.join("MockGone.compact"), "x").expect("written");
    let produced = case.produced(&[], &[], Some("src/a"));
    let own = plan(&produced, &case.paths).expect("owned");
    assert!(
        own.dirs
            .iter()
            .all(|entry| entry.dir.starts_with(case.dir("src/a")))
    );
    execute(&own, &[], &case.paths, &mut |_| Ok(())).expect("runs");
    assert!(outside.join("MockGone.compact").exists());
}

#[test]
fn a_name_filter_deletes_nothing_and_keeps_every_listed_name() {
    let case = Case::new();
    let dir = case.dir("src/a/test/artifacts");
    stamp(&dir, &["MockOld"]);
    std::fs::write(dir.join("MockOld.compact"), "x").expect("written");
    let produced = case.produced(&[("src/a/test/artifacts", &["MockNew"])], &[], None);
    let own = plan(&produced, &case.paths).expect("owned");
    execute(&own, &[target(&dir, "MockNew")], &case.paths, &mut |_| {
        Ok(())
    })
    .expect("runs");
    assert!(dir.join("MockOld.compact").exists());
    assert_eq!(
        parse_stamp(&std::fs::read_to_string(dir.join(STAMP)).expect("reads")),
        names(&["MockNew", "MockOld"])
    );
}

#[test]
fn a_symlinked_entry_is_removed_as_a_link_and_its_target_survives() {
    let case = Case::new();
    let dir = case.dir("src/a/test/artifacts");
    stamp(&dir, &["MockOld"]);
    let outside = case.dir("elsewhere");
    std::fs::create_dir_all(&outside).expect("dirs");
    std::fs::write(outside.join("keep.txt"), "x").expect("written");
    std::os::unix::fs::symlink(&outside, dir.join("MockOld")).expect("linked");
    let produced = case.produced(&[], &[], Some("src"));
    let own = plan(&produced, &case.paths).expect("owned");
    execute(&own, &[], &case.paths, &mut |_| Ok(())).expect("runs");
    assert!(std::fs::symlink_metadata(dir.join("MockOld")).is_err());
    assert!(outside.join("keep.txt").exists());
}

#[test]
fn the_stamp_lists_every_new_name_before_any_source_is_written() {
    let case = Case::new();
    let dir = case.dir("src/a/test/artifacts");
    stamp(&dir, &["MockOld"]);
    std::fs::write(dir.join("MockOld.compact"), "x").expect("written");
    let produced = case.produced(
        &[("src/a/test/artifacts", &["MockNew"])],
        &[("src/a/test/artifacts", &["MockNew"])],
        Some("src"),
    );
    let own = plan(&produced, &case.paths).expect("owned");
    let stop_after = |stop: Step| {
        move |step: Step| {
            if step == stop {
                Err(std::io::Error::other("interrupted"))
            } else {
                Ok(())
            }
        }
    };
    let failed = execute(
        &own,
        &[target(&dir, "MockNew")],
        &case.paths,
        &mut stop_after(Step::StampsWidened),
    );
    assert!(matches!(failed, Err(OutputError::Write { .. })));
    assert_eq!(
        parse_stamp(&std::fs::read_to_string(dir.join(STAMP)).expect("reads")),
        names(&["MockNew", "MockOld"])
    );
    assert!(!dir.join("MockNew.compact").exists());

    let failed = execute(
        &own,
        &[target(&dir, "MockNew")],
        &case.paths,
        &mut stop_after(Step::SourcesWritten),
    );
    assert!(failed.is_err());
    assert!(dir.join("MockNew.compact").exists() && dir.join("MockOld.compact").exists());
    assert_eq!(
        parse_stamp(&std::fs::read_to_string(dir.join(STAMP)).expect("reads")),
        names(&["MockNew", "MockOld"])
    );

    execute(&own, &[target(&dir, "MockNew")], &case.paths, &mut |_| {
        Ok(())
    })
    .expect("runs");
    assert!(!dir.join("MockOld.compact").exists());
    assert_eq!(
        parse_stamp(&std::fs::read_to_string(dir.join(STAMP)).expect("reads")),
        names(&["MockNew"])
    );
}

#[test]
fn a_stamped_directory_left_with_only_its_stamp_is_removed() {
    let case = Case::new();
    let dir = case.dir("src/a/test/artifacts");
    stamp(&dir, &["MockOld"]);
    std::fs::write(dir.join("MockOld.compact"), "x").expect("written");
    let produced = case.produced(&[], &[], Some("src"));
    let own = plan(&produced, &case.paths).expect("owned");
    execute(&own, &[], &case.paths, &mut |_| Ok(())).expect("runs");
    assert!(!dir.exists());
    assert!(case.dir("src/a/test").exists());
}

#[test]
fn a_directory_whose_module_failed_is_never_cleaned() {
    let case = Case::new();
    let dir = case.dir("src/a/test/artifacts");
    stamp(&dir, &["MockOld"]);
    std::fs::write(dir.join("MockOld.compact"), "x").expect("written");
    let mut produced = case.produced(&[], &[], Some("src"));
    produced.unsure.insert(dir.clone());
    let own = plan(&produced, &case.paths).expect("owned");
    execute(&own, &[], &case.paths, &mut |_| Ok(())).expect("runs");
    assert!(dir.join("MockOld.compact").exists());
}

#[test]
fn a_new_directory_is_created_with_its_stamp() {
    let case = Case::new();
    let dir = case.dir("src/a/test/artifacts");
    let produced = case.produced(
        &[("src/a/test/artifacts", &["MockA"])],
        &[("src/a/test/artifacts", &["MockA"])],
        Some("src"),
    );
    let own = plan(&produced, &case.paths).expect("owned");
    let report =
        execute(&own, &[target(&dir, "MockA")], &case.paths, &mut |_| Ok(())).expect("runs");
    assert_eq!(report.targets.len(), 1);
    assert_eq!(
        std::fs::read_to_string(dir.join(STAMP)).expect("reads"),
        render_stamp(&names(&["MockA"]))
    );
}
