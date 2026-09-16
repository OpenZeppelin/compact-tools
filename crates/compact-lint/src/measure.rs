//! Measuring a circuit's proving key size and row count with `compact compile`.
//!
//! `k` and `rows` reach only the compiler's terminal progress output, so the compile runs
//! under a pty and the transcript is parsed. Results go to the `circuit-info.json` the
//! TypeScript builder writes in a contract's artifact directory, in the same shape.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use walkdir::WalkDir;

/// One contract's measurements, beside the compiler's own output in its artifact directory.
pub const ARTIFACT_FILE_NAME: &str = "circuit-info.json";

/// The compiler's own report of the circuits it built, under the artifacts directory.
const CONTRACT_INFO_PATH: [&str; 2] = ["compiler", "contract-info.json"];

/// A dependency tree carries its own artifacts, so the search never descends into one.
const SKIPPED_DIR: &str = "node_modules";

/// Compiler-output lines kept in a failure report.
const TAIL_LINES: usize = 20;

/// Terminal geometry for the compile; a wide row keeps a progress line off the wrap.
const PTY_SIZE: PtySize = PtySize {
    rows: 60,
    cols: 200,
    pixel_width: 0,
    pixel_height: 0,
};

#[derive(Debug, Error)]
pub enum MeasureError {
    #[error("cannot run `{binary}` under a pty")]
    Spawn {
        binary: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync + 'static>,
    },
    #[error("cannot read the compiler output for {file}")]
    Transcript {
        file: PathBuf,
        #[source]
        cause: std::io::Error,
    },
    #[error("compiling {file} failed:\n{tail}")]
    Compile { file: PathBuf, tail: String },
    #[error("cannot read {path}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot write {path}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("cannot parse {path}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error(
        "no measurement for {file} at {path}; compile it, or run fill-constraints without --no-compile"
    )]
    CacheMiss { file: PathBuf, path: PathBuf },
    #[error("several artifact directories are named {stem}: {}", list(paths))]
    AmbiguousArtifact { stem: String, paths: Vec<PathBuf> },
}

/// Paths as one comma-separated line, for an error message.
fn list(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

/// One circuit's measured constraints.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Constraints {
    pub k: u32,
    pub rows: u32,
}

impl Constraints {
    /// The annotation value, the one spelling `check` accepts.
    #[must_use]
    pub fn value(self) -> String {
        format!("k={}, rows={}", self.k, self.rows)
    }
}

/// One circuit of the `circuit-info.json` list.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Measurement {
    pub name: String,
    pub k: u32,
    pub rows: u32,
}

impl Measurement {
    #[must_use]
    pub const fn constraints(&self) -> Constraints {
        Constraints {
            k: self.k,
            rows: self.rows,
        }
    }
}

/// The `circuit-info.json` shape, shared with the TypeScript builder.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct CircuitInfo {
    #[serde(rename = "generatedAt")]
    generated_at: String,
    /// The compiled file, as its writer spelled it; the directory, not this, locates a source.
    #[serde(default)]
    source: String,
    #[serde(default)]
    circuits: Vec<Measurement>,
}

/// The compiler's circuit list; only `proof` circuits carry constraints.
#[derive(Debug, Deserialize)]
struct ContractInfo {
    #[serde(default)]
    circuits: Vec<ContractCircuit>,
}

#[derive(Debug, Deserialize)]
struct ContractCircuit {
    name: String,
    #[serde(default = "proves")]
    proof: bool,
}

/// An absent `proof` flag predates the field, when every circuit was proved.
const fn proves() -> bool {
    true
}

/// One `compact compile` invocation, reused for every source in a run.
pub struct Compiler {
    pub binary: OsString,
    /// Toolchain version passed as `+<version>`.
    pub version: Option<String>,
    /// Where each source's output directory is created.
    pub artifacts: PathBuf,
    /// The child's working directory, so a relative source path resolves as it reads.
    pub cwd: PathBuf,
}

impl Compiler {
    /// Compiles one source and returns the circuits the compiler measured.
    /// # Errors
    /// Returns an error when the binary cannot run, the compile fails, or the
    /// artifacts cannot be read.
    pub fn measure(&self, source: &Path) -> Result<Vec<Measurement>, MeasureError> {
        let output = self.artifacts.join(stem(source));
        std::fs::create_dir_all(&output).map_err(|cause| MeasureError::Write {
            path: output.clone(),
            source: cause,
        })?;

        let (status, raw) = self.spawn(source, &output)?;
        let cleaned = clean(&raw);
        if status != 0 {
            return Err(MeasureError::Compile {
                file: source.to_owned(),
                tail: tail(&cleaned, TAIL_LINES),
            });
        }

        let mut measured = parse(&cleaned);
        if let Some(proved) = proved_circuits(&output)? {
            measured.retain(|measurement| proved.contains(&measurement.name));
        }
        Ok(measured)
    }

    /// Runs the compile under a pty and returns its exit code and raw transcript.
    fn spawn(&self, source: &Path, output: &Path) -> Result<(i32, String), MeasureError> {
        let pty = native_pty_system();
        let pair = pty
            .openpty(PTY_SIZE)
            .map_err(|cause| self.spawn_error(cause))?;

        let mut command = CommandBuilder::new(&self.binary);
        command.arg("compile");
        if let Some(version) = &self.version {
            command.arg(format!("+{version}"));
        }
        command.arg(source);
        command.arg(output);
        command.env("TERM", "xterm-256color");
        command.cwd(&self.cwd);

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|cause| self.spawn_error(cause))?;
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|cause| self.spawn_error(cause))?;
        let mut raw = Vec::new();
        reader
            .read_to_end(&mut raw)
            .map_err(|cause| MeasureError::Transcript {
                file: source.to_owned(),
                cause,
            })?;

        let status = child.wait().map_err(|cause| MeasureError::Transcript {
            file: source.to_owned(),
            cause,
        })?;
        drop(pair.master);

        let code = i32::try_from(status.exit_code()).unwrap_or(i32::MAX);
        Ok((code, String::from_utf8_lossy(&raw).into_owned()))
    }

    fn spawn_error(&self, cause: anyhow::Error) -> MeasureError {
        MeasureError::Spawn {
            binary: self.binary.to_string_lossy().into_owned(),
            source: cause.into(),
        }
    }
}

/// The names of the circuits the compiler proved, or `None` without a contract report.
fn proved_circuits(output: &Path) -> Result<Option<Vec<String>>, MeasureError> {
    let path = CONTRACT_INFO_PATH
        .iter()
        .fold(output.to_owned(), |path, segment| path.join(segment));
    if !path.is_file() {
        return Ok(None);
    }

    let text = std::fs::read_to_string(&path).map_err(|source| MeasureError::Read {
        path: path.clone(),
        source,
    })?;
    let info: ContractInfo =
        serde_json::from_str(&text).map_err(|source| MeasureError::Parse { path, source })?;

    Ok(Some(
        info.circuits
            .into_iter()
            .filter(|circuit| circuit.proof)
            .map(|circuit| circuit.name)
            .collect(),
    ))
}

/// A source's artifact file, in the directory the compiler writes for it.
#[must_use]
pub fn artifact_path(artifacts: &Path, source: &Path) -> PathBuf {
    artifacts.join(stem(source)).join(ARTIFACT_FILE_NAME)
}

/// Finds a source's artifact file: its own directory first, then a search of the tree.
///
/// A hierarchical build nests the contract directory under the subdirectory it was
/// compiled from.
/// # Errors
/// Returns an error when no directory under `artifacts` holds the file, or several do.
pub fn locate(artifacts: &Path, source: &Path) -> Result<PathBuf, MeasureError> {
    let flat = artifact_path(artifacts, source);
    if flat.is_file() {
        return Ok(flat);
    }

    let mut nested = search(artifacts, &stem(source));
    if nested.len() > 1 {
        return Err(MeasureError::AmbiguousArtifact {
            stem: stem(source),
            paths: nested,
        });
    }
    nested.pop().ok_or_else(|| MeasureError::CacheMiss {
        file: source.to_owned(),
        path: flat,
    })
}

/// Every artifact file under `artifacts` whose contract directory is named `stem`.
fn search(artifacts: &Path, stem: &str) -> Vec<PathBuf> {
    WalkDir::new(artifacts)
        .follow_links(false)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || entry.file_name() != SKIPPED_DIR)
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_dir() && entry.file_name() == OsStr::new(stem))
        .map(|entry| entry.path().join(ARTIFACT_FILE_NAME))
        .filter(|path| path.is_file())
        .collect()
}

/// Reads one contract's measurements from its artifact file.
/// # Errors
/// Returns an error when the file is unreadable or malformed.
pub fn read_artifact(path: &Path) -> Result<Vec<Measurement>, MeasureError> {
    let text = std::fs::read_to_string(path).map_err(|source| MeasureError::Read {
        path: path.to_owned(),
        source,
    })?;
    let info: CircuitInfo = serde_json::from_str(&text).map_err(|source| MeasureError::Parse {
        path: path.to_owned(),
        source,
    })?;
    Ok(info.circuits)
}

/// Writes one contract's measurements, replacing whatever the file held.
///
/// `recorded` is the compiled file's path as the artifact spells it.
/// # Errors
/// Returns an error when the directory or the file cannot be written.
pub fn write_artifact(
    artifacts: &Path,
    source: &Path,
    recorded: &str,
    measured: &[Measurement],
) -> Result<PathBuf, MeasureError> {
    let path = artifact_path(artifacts, source);
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(directory).map_err(|source| MeasureError::Write {
        path: directory.to_owned(),
        source,
    })?;

    let info = CircuitInfo {
        generated_at: timestamp(SystemTime::now()),
        source: recorded.to_owned(),
        circuits: measured.to_vec(),
    };
    let mut text = serde_json::to_string_pretty(&info).map_err(|source| MeasureError::Parse {
        path: path.clone(),
        source,
    })?;
    text.push('\n');
    std::fs::write(&path, text).map_err(|source| MeasureError::Write {
        path: path.clone(),
        source,
    })?;
    Ok(path)
}

/// The contract directory's name: the source's file stem.
fn stem(source: &Path) -> String {
    source
        .file_stem()
        .unwrap_or_else(|| OsStr::new("contract"))
        .to_string_lossy()
        .into_owned()
}

/// Strips ANSI escapes, spinner frames and carriage-return redraws from pty output.
#[must_use]
pub fn clean(raw: &str) -> String {
    let stripped = strip_escapes(raw);
    let mut out = String::with_capacity(stripped.len());
    for (index, line) in stripped.split('\n').enumerate() {
        if index > 0 {
            out.push('\n');
        }
        out.push_str(&clean_line(line));
    }
    out
}

/// The compiler redraws a line over itself, so only the text after the last `\r` is visible.
fn clean_line(line: &str) -> String {
    let body = line.strip_suffix('\r').unwrap_or(line);
    let visible = body.rsplit('\r').next().unwrap_or(body);

    let mut out = String::with_capacity(visible.len());
    let mut spaced = false;
    for character in visible.chars() {
        if is_spinner(character) {
            continue;
        }
        if character.is_whitespace() {
            spaced = true;
            continue;
        }
        if spaced && !out.is_empty() {
            out.push(' ');
        }
        spaced = false;
        out.push(character);
    }
    out
}

/// Braille frames and the tick / cross the compiler marks a finished circuit with.
fn is_spinner(character: char) -> bool {
    matches!(character, '\u{2800}'..='\u{28ff}' | '✓' | '✔' | '✗' | '✘')
}

/// Drops CSI, OSC and character-set escape sequences, keeping the visible text.
fn strip_escapes(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut characters = raw.chars();

    while let Some(character) = characters.next() {
        if character != '\u{1b}' {
            out.push(character);
            continue;
        }
        match characters.next() {
            // A CSI sequence runs to its first byte in the 0x40..0x7e range.
            Some('[') => {
                for parameter in characters.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&parameter) {
                        break;
                    }
                }
            }
            // An OSC sequence runs to a BEL or a string terminator.
            Some(']') => {
                let mut escaped = false;
                for parameter in characters.by_ref() {
                    if parameter == '\u{7}' || (escaped && parameter == '\\') {
                        break;
                    }
                    escaped = parameter == '\u{1b}';
                }
            }
            Some('(' | ')') => {
                characters.next();
            }
            _ => {}
        }
    }
    out
}

/// Every measured circuit in a cleaned transcript; the last line for a name wins.
#[must_use]
pub fn parse(cleaned: &str) -> Vec<Measurement> {
    let mut found: BTreeMap<String, Measurement> = BTreeMap::new();
    for line in cleaned.lines() {
        if let Some(measurement) = parse_line(line) {
            found.insert(measurement.name.clone(), measurement);
        }
    }
    found.into_values().collect()
}

/// Matches `circuit "<name>" (k=<n>, rows=<n>)`, the compiler's per-circuit progress line.
fn parse_line(line: &str) -> Option<Measurement> {
    let after = line.split_once("circuit ")?.1.trim_start();
    let (name, rest) = after.strip_prefix('"')?.split_once('"')?;
    let fields = rest.trim_start().strip_prefix('(')?.split_once(')')?.0;
    let (k, rows) = fields.split_once(',')?;

    Some(Measurement {
        name: name.to_owned(),
        k: field(k, "k")?,
        rows: field(rows, "rows")?,
    })
}

/// One `<name>=<digits>` field of a progress line.
fn field(text: &str, name: &str) -> Option<u32> {
    text.trim()
        .strip_prefix(name)?
        .trim_start()
        .strip_prefix('=')?
        .trim()
        .parse()
        .ok()
}

/// The last `keep` non-blank lines of a cleaned transcript, with repeats dropped.
#[must_use]
pub fn tail(cleaned: &str, keep: usize) -> String {
    let mut lines: Vec<&str> = Vec::new();
    for line in cleaned.lines().map(str::trim) {
        if line.is_empty() || lines.last() == Some(&line) {
            continue;
        }
        lines.push(line);
    }

    let start = lines.len().saturating_sub(keep);
    lines[start..].join("\n")
}

/// An RFC 3339 UTC timestamp, the spelling the TypeScript builder writes.
fn timestamp(now: SystemTime) -> String {
    let seconds = now
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let (year, month, day) = civil_date(i64::try_from(days).unwrap_or(0));

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// Days since the epoch to a civil date, by Howard Hinnant's `civil_from_days`.
fn civil_date(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;

    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    (year + i64::from(month <= 2), month, day)
}

#[cfg(test)]
mod tests {
    use super::{
        ARTIFACT_FILE_NAME, MeasureError, Measurement, civil_date, clean, locate, parse,
        read_artifact, tail, timestamp, write_artifact,
    };
    use std::path::Path;
    use std::time::{Duration, UNIX_EPOCH};

    /// A pty transcript of `compact compile … MockOwnable.compact`, trimmed to two frames.
    fn transcript() -> String {
        std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fill-transcript/pty.txt"),
        )
        .expect("the captured transcript is readable")
    }

    fn measurement(name: &str, k: u32, rows: u32) -> Measurement {
        Measurement {
            name: name.to_owned(),
            k,
            rows,
        }
    }

    #[test]
    fn a_pty_transcript_yields_one_measurement_per_circuit() {
        let measured = parse(&clean(&transcript()));

        assert_eq!(
            measured,
            [
                measurement("_transferOwnership", 10, 598),
                measurement("_unsafeTransferOwnership", 13, 4868),
                measurement("_unsafeUncheckedTransferOwnership", 10, 595),
                measurement("assertOnlyOwner", 13, 4273),
                measurement("owner", 7, 74),
                measurement("renounceOwnership", 13, 4277),
                measurement("transferOwnership", 13, 4871),
            ]
        );
    }

    #[test]
    fn the_last_line_for_a_name_wins_over_the_partial_frames_above_it() {
        let frames = "  circuit \"owner\" (k=7)\n  circuit \"owner\" (k=7, rows=9999)\n  circuit \"owner\" (k=7, rows=74)\n";

        assert_eq!(parse(frames), [measurement("owner", 7, 74)]);
    }

    #[test]
    fn escapes_and_redraws_leave_only_the_visible_text() {
        let raw = "\u{1b}[2K  circuit \"owner\" \u{1b}[32m|\u{1b}[0m   \r\u{1b}[2K  circuit \"owner\" (k=7, rows=74)\r\n";

        assert_eq!(clean(raw), "circuit \"owner\" (k=7, rows=74)\n");
    }

    #[test]
    fn a_line_without_both_fields_is_not_a_measurement() {
        assert!(parse("  circuit \"owner\" (k=7)\n").is_empty());
        assert!(parse("Compiling 7 circuits:\n").is_empty());
        assert!(parse("  circuit \"owner\" (rows=74, k=7)\n").is_empty());
    }

    #[test]
    fn a_failure_tail_keeps_the_last_distinct_lines() {
        let cleaned = "one\none\ntwo\n\nthree\nfour\n";

        assert_eq!(tail(cleaned, 2), "three\nfour");
        assert_eq!(tail(cleaned, 20), "one\ntwo\nthree\nfour");
    }

    /// Seeds `<artifacts>/<directory>/circuit-info.json` with one measured circuit.
    fn seed(artifacts: &Path, directory: &str) {
        let target = artifacts.join(directory);
        std::fs::create_dir_all(&target).expect("the tree is writable");
        std::fs::write(
            target.join(ARTIFACT_FILE_NAME),
            "{\n  \"generatedAt\": \"2026-01-01T00:00:00.000Z\",\n  \"source\": \"src/MockOwnable.compact\",\n  \"circuits\": [{ \"name\": \"owner\", \"k\": 7, \"rows\": 74 }]\n}\n",
        )
        .expect("the artifact is writable");
    }

    #[test]
    fn a_written_artifact_reads_back_with_the_source_it_records() {
        let directory = tempfile::tempdir().expect("a temporary directory is available");
        let source = Path::new("src/access/test/mocks/MockOwnable.compact");
        let written = [measurement("owner", 7, 74)];

        let path = write_artifact(
            directory.path(),
            source,
            "src/access/test/mocks/MockOwnable.compact",
            &written,
        )
        .expect("the artifact is writable");
        let text = std::fs::read_to_string(&path).expect("the artifact is readable");

        assert_eq!(path, directory.path().join("MockOwnable/circuit-info.json"));
        assert!(
            text.contains("\"source\": \"src/access/test/mocks/MockOwnable.compact\""),
            "{text}"
        );
        assert_eq!(
            read_artifact(&path).expect("the artifact parses"),
            written.to_vec()
        );
    }

    #[test]
    fn a_nested_contract_directory_is_found_by_its_stem() {
        let directory = tempfile::tempdir().expect("a temporary directory is available");
        seed(directory.path(), "access/MockOwnable");

        let found = locate(
            directory.path(),
            Path::new("src/access/test/mocks/MockOwnable.compact"),
        )
        .expect("the nested artifact is found");

        assert_eq!(
            found,
            directory
                .path()
                .join("access/MockOwnable/circuit-info.json")
        );
    }

    #[test]
    fn two_contract_directories_of_one_stem_are_ambiguous() {
        let directory = tempfile::tempdir().expect("a temporary directory is available");
        seed(directory.path(), "access/MockOwnable");
        seed(directory.path(), "token/MockOwnable");

        let error = locate(directory.path(), Path::new("MockOwnable.compact"))
            .expect_err("the stem names two directories");

        assert!(
            matches!(error, MeasureError::AmbiguousArtifact { ref stem, ref paths }
                if stem == "MockOwnable" && paths.len() == 2),
            "{error}"
        );
    }

    #[test]
    fn a_source_with_no_artifact_names_the_path_it_tried() {
        let directory = tempfile::tempdir().expect("a temporary directory is available");

        let error = locate(directory.path(), Path::new("src/Gone.compact"))
            .expect_err("nothing was compiled");

        assert!(
            error
                .to_string()
                .contains("Gone/circuit-info.json; compile it"),
            "{error}"
        );
    }

    #[test]
    fn a_timestamp_renders_as_utc_rfc_3339() {
        let moment = UNIX_EPOCH + Duration::from_hours(490_896);

        assert_eq!(timestamp(moment), "2026-01-01T00:00:00.000Z");
        assert_eq!(civil_date(0), (1970, 1, 1));
    }
}
