//! Module discovery under `src` and rule selection.
//!
//! Candidates are the `.compact` files under `src` in sorted path order, minus dot
//! directories, `node_modules`, every test directory and every fragment. So a hand-written
//! mock, a generated mock or a fragment is never a candidate.

use std::path::{Path, PathBuf};

use crate::config::{Config, FRAGMENT_SUFFIX, Paths};
use crate::error::{ConfigError, OutputError};

/// One `.compact` file under `src`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// Relative to `src`, `/`-separated, without `.compact`.
    pub module: String,
    /// Absolute and normalized.
    pub file: PathBuf,
}

/// How the config treats a candidate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Selection {
    /// `[mock].exclude` matches it.
    Excluded,
    /// No rule applies to it.
    Unmatched,
    /// The rules that apply, in file order.
    Selected(Vec<usize>),
}

/// Why a selected candidate gets no mock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SkipReason {
    NotAModule,
    NoExportedCircuits,
    /// Generic, without `module_args`, and every rule names it by a glob.
    GenericModule,
    /// Its init circuit is generic, without `circuit_args`, and every rule names it by a
    /// glob.
    GenericInit,
}

impl SkipReason {
    #[must_use]
    pub const fn text(self) -> &'static str {
        match self {
            Self::NotAModule => "not a module",
            Self::NoExportedCircuits => "no exported circuits",
            Self::GenericModule => {
                "generic module without module_args; name it in a rule that sets module_args to mock it"
            }
            Self::GenericInit => {
                "generic init circuit without circuit_args; name the module in a rule that sets them to mock it"
            }
        }
    }

    /// Whether the skip hides a module a rule meant to mock, so coverage reports it.
    #[must_use]
    pub const fn is_gap(self) -> bool {
        matches!(self, Self::GenericModule | Self::GenericInit)
    }
}

/// Every candidate under `src`, in sorted module-path order.
/// # Errors
/// Returns the error of a directory that cannot be listed.
pub fn candidates(config: &Config) -> Result<Vec<Candidate>, OutputError> {
    let mut found = Vec::new();
    walk(config, &config.src, &mut Vec::new(), &mut found)?;
    found.sort_by(|left: &Candidate, right| left.module.as_bytes().cmp(right.module.as_bytes()));
    Ok(found)
}

fn walk(
    config: &Config,
    directory: &Path,
    segments: &mut Vec<String>,
    found: &mut Vec<Candidate>,
) -> Result<(), OutputError> {
    let listing = std::fs::read_dir(directory).map_err(|source| OutputError::Read {
        path: directory.display().to_string(),
        source,
    })?;
    for entry in listing {
        let entry = entry.map_err(|source| OutputError::Read {
            path: directory.display().to_string(),
            source,
        })?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            segments.push(name);
            if !is_test_dir(segments, &config.test_tail) {
                walk(config, &path, segments, found)?;
            }
            segments.pop();
        } else if let Some(stem) = name.strip_suffix(".compact")
            && !name.ends_with(FRAGMENT_SUFFIX)
            && path.is_file()
        {
            let mut module = segments.clone();
            module.push(stem.to_owned());
            found.push(Candidate {
                module: module.join("/"),
                file: path,
            });
        }
    }
    Ok(())
}

/// Whether a directory, as segments relative to `src`, ends with the test-directory tail.
#[must_use]
pub fn is_test_dir(segments: &[String], tail: &[String]) -> bool {
    !tail.is_empty() && segments.len() >= tail.len() && segments.ends_with(tail)
}

/// How the config treats `module`.
#[must_use]
pub fn select(config: &Config, module: &str) -> Selection {
    if config.exclude.matches(module) {
        return Selection::Excluded;
    }
    let applicable = config.applicable(module);
    if applicable.is_empty() {
        Selection::Unmatched
    } else {
        Selection::Selected(applicable)
    }
}

/// The exclude patterns that exclude nothing, as information lines: a `[mock].exclude`
/// pattern no candidate matches, and an `exclude_modules` pattern no candidate of its
/// rule's `modules` matches.
#[must_use]
pub fn unused_excludes(config: &Config, candidates: &[Candidate]) -> Vec<ConfigError> {
    let mut found = Vec::new();
    let used = |globs: &crate::config::Globs, keep: &dyn Fn(&str) -> bool| {
        let mut used = vec![false; globs.patterns.len()];
        for candidate in candidates
            .iter()
            .filter(|candidate| keep(&candidate.module))
        {
            for index in globs.matching(&candidate.module) {
                used[index] = true;
            }
        }
        used
    };
    for (index, used) in used(&config.exclude, &|_| true).into_iter().enumerate() {
        if !used {
            found.push(ConfigError::ExcludeUnused {
                cfg: config.shown.clone(),
                at: "[mock].exclude".to_owned(),
                pattern: config.exclude.patterns[index].clone(),
            });
        }
    }
    for rule in &config.rules {
        let selected = |module: &str| rule.modules.matches(module);
        for (index, used) in used(&rule.exclude_modules, &selected)
            .into_iter()
            .enumerate()
        {
            if !used {
                found.push(ConfigError::ExcludeUnused {
                    cfg: config.shown.clone(),
                    at: format!("[[mock.rules]] #{} exclude_modules", rule.number),
                    pattern: rule.exclude_modules.patterns[index].clone(),
                });
            }
        }
    }
    found
}

/// Whether a compact-compiler file glob matches `path`: `*` spans any characters, `/`
/// included, and `?` one. A glob with `/` matches the path as printed, relative to the
/// working directory; any other glob matches the file name.
#[must_use]
pub fn file_glob(glob: &str, path: &Path, paths: &Paths) -> bool {
    let text = if glob.contains('/') {
        paths.show(path)
    } else {
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let pattern: Vec<char> = glob.chars().collect();
    let text: Vec<char> = text.chars().collect();
    wildcard(&pattern, &text)
}

/// `*` and `?` matching with one backtrack point, linear in practice.
fn wildcard(pattern: &[char], text: &[char]) -> bool {
    let (mut p, mut t) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while t < text.len() {
        match pattern.get(p) {
            Some('*') => {
                star = Some((p, t));
                p += 1;
            }
            Some(&ch) if ch == '?' || ch == text[t] => {
                p += 1;
                t += 1;
            }
            _ => match star {
                Some((at, from)) => {
                    p = at + 1;
                    t = from + 1;
                    star = Some((at, from + 1));
                }
                None => return false,
            },
        }
    }
    pattern[p..].iter().all(|ch| *ch == '*')
}

/// The rules that apply to no candidate `[mock].exclude` leaves, as information lines.
#[must_use]
pub fn unused_rules(
    config: &Config,
    candidates: &[Candidate],
    paths_src: &str,
) -> Vec<ConfigError> {
    config
        .rules
        .iter()
        .filter(|rule| {
            !candidates.iter().any(|candidate| {
                rule.applies(&candidate.module) && !config.exclude.matches(&candidate.module)
            })
        })
        .map(|rule| ConfigError::RuleUnused {
            cfg: config.shown.clone(),
            number: rule.number,
            src: paths_src.to_owned(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{Selection, candidates, is_test_dir, select, unused_rules};
    use crate::config::{CONFIG_FILE_NAME, Paths, load};

    fn tree(files: &[&str], config: &str) -> (tempfile::TempDir, crate::config::Config) {
        let directory = tempfile::TempDir::new().expect("a temporary directory");
        std::fs::create_dir(directory.path().join("src")).expect("src");
        for file in files {
            let path = directory.path().join("src").join(file);
            std::fs::create_dir_all(path.parent().expect("a parent")).expect("dirs");
            std::fs::write(path, "").expect("written");
        }
        std::fs::write(directory.path().join(CONFIG_FILE_NAME), config).expect("written");
        let paths = Paths {
            cwd: directory.path().to_owned(),
        };
        let config = load(&directory.path().join(CONFIG_FILE_NAME), &paths).expect("loads");
        (directory, config)
    }

    #[test]
    fn test_directories_fragments_dot_dirs_and_node_modules_are_never_candidates() {
        let (_directory, config) = tree(
            &[
                "access/Ownable.compact",
                "access/test/mocks/MockOwnable.compact",
                "access/test/artifacts/MockOwnable.compact",
                "access/test/MockOwnable.fragment.compact",
                "access/Ownable.fragment.compact",
                ".hidden/X.compact",
                "node_modules/y/Y.compact",
                "Root.compact",
                "a/b/Deep.compact",
                "notes.md",
            ],
            "[mock]\n[[mock.rules]]\nmodules = [\"**\"]\n",
        );
        let found: Vec<String> = candidates(&config)
            .expect("walks")
            .into_iter()
            .map(|candidate| candidate.module)
            .collect();
        assert_eq!(found, ["Root", "a/b/Deep", "access/Ownable"]);
    }

    #[test]
    fn a_nested_test_dir_template_skips_only_that_tail() {
        let tail = vec!["test".to_owned(), "unit".to_owned()];
        let segments = |path: &str| path.split('/').map(str::to_owned).collect::<Vec<_>>();
        assert!(is_test_dir(&segments("a/test/unit"), &tail));
        assert!(!is_test_dir(&segments("a/test"), &tail));
        assert!(!is_test_dir(&segments("a/unit"), &tail));
    }

    #[test]
    fn a_star_stays_in_one_segment_and_a_double_star_crosses_them() {
        let (_directory, config) = tree(
            &["access/Ownable.compact", "access/extensions/Role.compact"],
            "[mock]\nexclude = [\"access/extensions/Role\"]\n\
             [[mock.rules]]\nmodules = [\"access/*\"]\n\
             [[mock.rules]]\nmodules = [\"access/**\"]\nexclude_modules = [\"access/Ownable\"]\n",
        );
        assert_eq!(
            select(&config, "access/Ownable"),
            Selection::Selected(vec![0])
        );
        assert_eq!(
            select(&config, "access/extensions/Role"),
            Selection::Excluded
        );
        assert_eq!(select(&config, "token/Token"), Selection::Unmatched);
        assert_eq!(config.applicable("access/extensions/Other"), [1]);
    }

    #[test]
    fn a_rule_that_matches_no_candidate_left_by_the_exclusions_is_reported_by_number() {
        let (_directory, config) = tree(
            &["access/Ownable.compact", "math/Scale.compact"],
            "[mock]\nexclude = [\"math/*\"]\n[[mock.rules]]\nmodules = [\"access/*\"]\n[[mock.rules]]\nmodules = [\"acess/*\", \"math/Scale\"]\n",
        );
        let found = candidates(&config).expect("walks");
        let errors: Vec<String> = unused_rules(&config, &found, "src")
            .iter()
            .map(ToString::to_string)
            .collect();
        assert_eq!(
            errors,
            [format!(
                "config {CONFIG_FILE_NAME}: [[mock.rules]] #2 applies to no module under src"
            )]
        );
    }
}
