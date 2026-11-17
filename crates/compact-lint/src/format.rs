//! The optional `compact format --check` pass.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

use thiserror::Error;

use crate::report::{Finding, Position, RuleId};

/// Environment override for the `compact` binary; the `--compact-bin` flag wins over it.
pub const COMPACT_BIN_ENV: &str = "COMPACT_LINT_COMPACT_BIN";

/// The default binary name, resolved through `PATH`.
pub const DEFAULT_COMPACT_BIN: &str = "compact";

pub const MESSAGE: &str = "not formatted; run `compact format`";

#[derive(Debug, Error)]
pub enum FormatError {
    #[error("cannot run `{binary}`; pass --no-format to skip the format check")]
    BinaryMissing { binary: String },
    #[error("cannot run `{binary}`")]
    Spawn {
        binary: String,
        #[source]
        source: std::io::Error,
    },
}

/// Runs `compact format --check` once over every file and maps its report to findings.
///
/// The formatter writes one `<path>:` line per unformatted file to stderr, followed by
/// an indented diff. An output that holds no such line yields one finding on the first
/// checked file carrying the formatter's own first line.
/// # Errors
/// Returns an error when the `compact` binary is missing or cannot be spawned.
pub fn check(binary: &OsStr, files: &[PathBuf]) -> Result<Vec<Finding>, FormatError> {
    if files.is_empty() {
        return Ok(Vec::new());
    }

    let output = Command::new(binary)
        .arg("format")
        .arg("--check")
        .args(files)
        .output()
        .map_err(|source| {
            let binary = binary.to_string_lossy().into_owned();
            if source.kind() == std::io::ErrorKind::NotFound {
                FormatError::BinaryMissing { binary }
            } else {
                FormatError::Spawn { binary, source }
            }
        })?;

    if output.status.success() {
        return Ok(Vec::new());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let reported: Vec<&str> = reported_paths(&stderr)
        .chain(reported_paths(&stdout))
        .collect();

    if reported.is_empty() {
        let raw = first_line(&stderr)
            .or_else(|| first_line(&stdout))
            .unwrap_or("compact format --check failed");
        return Ok(vec![Finding::new(
            files[0].clone(),
            Position::file_start(),
            RuleId::FORMAT,
            raw.to_owned(),
        )]);
    }

    Ok(reported
        .into_iter()
        .map(|path| {
            Finding::new(
                resolve(path, files),
                Position::file_start(),
                RuleId::FORMAT,
                MESSAGE.to_owned(),
            )
        })
        .collect())
}

/// Unformatted files are announced as a flush-left `<path>:` line.
fn reported_paths(output: &str) -> impl Iterator<Item = &str> {
    output.lines().filter_map(|line| {
        let path = line.strip_suffix(':')?;
        (!path.is_empty() && !path.starts_with(char::is_whitespace) && path.ends_with(".compact"))
            .then_some(path)
    })
}

/// Prefers the path spelling the caller passed in, so output stays consistent.
/// Matching is by whole path components, so `Token.compact` never claims `NativeToken.compact`.
fn resolve(reported: &str, files: &[PathBuf]) -> PathBuf {
    let reported = Path::new(reported);
    files
        .iter()
        .find(|file| reported.ends_with(file) || file.ends_with(reported))
        .cloned()
        .unwrap_or_else(|| reported.to_owned())
}

fn first_line(output: &str) -> Option<&str> {
    output.lines().map(str::trim).find(|line| !line.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{reported_paths, resolve};
    use std::path::PathBuf;

    const SAMPLE: &str = "/tmp/bad.compact:\n   18 |  export ledger round: Counter;\n-  21 | -        round.increment(1);\n+  21 | +  round.increment(1);\n\nError: formatting failed\n";

    #[test]
    fn flush_left_path_lines_become_findings() {
        let paths: Vec<&str> = reported_paths(SAMPLE).collect();

        assert_eq!(paths, ["/tmp/bad.compact"]);
    }

    #[test]
    fn indented_diff_lines_are_not_paths() {
        let paths: Vec<&str> = reported_paths("   a.compact:\n\ttrailing:\n").collect();

        assert!(paths.is_empty());
    }

    #[test]
    fn an_absolute_report_maps_back_to_the_relative_path_passed_in() {
        let files = [PathBuf::from("contracts/src/Token.compact")];

        assert_eq!(
            resolve("/work/contracts/src/Token.compact", &files),
            PathBuf::from("contracts/src/Token.compact")
        );
    }

    #[test]
    fn a_shorter_file_name_with_the_same_suffix_is_not_a_match() {
        let files = [PathBuf::from("Token.compact")];

        assert_eq!(
            resolve("/work/NativeToken.compact", &files),
            PathBuf::from("/work/NativeToken.compact")
        );
    }
}
