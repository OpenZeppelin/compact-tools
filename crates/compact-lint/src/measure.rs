//! Measuring a circuit's proving key size and row count with `compact compile`.
//!
//! `k` and `rows` reach only the compiler's terminal progress output, so the compile runs
//! under a pty and the transcript is parsed. Results are cached in the
//! `.circuit-info.json` file the TypeScript builder writes, in the same shape.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The measurement cache, written beside the compiled source.
pub const CACHE_FILE_NAME: &str = ".circuit-info.json";

/// The compiler's own report of the circuits it built, under the artifacts directory.
const CONTRACT_INFO_PATH: [&str; 2] = ["compiler", "contract-info.json"];

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
    #[error("{path} has no cached measurement for {name}; drop --no-compile to compile it")]
    CacheMiss { path: PathBuf, name: String },
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

/// One entry of the `.circuit-info.json` cache.
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

/// The `.circuit-info.json` shape, shared with the TypeScript builder.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct CircuitInfo {
    #[serde(rename = "generatedAt")]
    generated_at: String,
    files: BTreeMap<String, Vec<Measurement>>,
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
        let stem = source
            .file_stem()
            .unwrap_or_else(|| OsStr::new("contract"))
            .to_owned();
        let output = self.artifacts.join(&stem);
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

/// Reads a source's entry from the cache beside it.
/// # Errors
/// Returns an error when the cache is unreadable or malformed.
pub fn read_cache(source: &Path) -> Result<Option<Vec<Measurement>>, MeasureError> {
    let path = cache_path(source);
    if !path.is_file() {
        return Ok(None);
    }

    let info = load_cache(&path)?;
    Ok(info.files.get(&file_key(source)).cloned())
}

/// Writes a source's entry into the cache beside it, keeping every other entry.
/// # Errors
/// Returns an error when the cache is unreadable, malformed or unwritable.
pub fn write_cache(source: &Path, measured: &[Measurement]) -> Result<PathBuf, MeasureError> {
    let path = cache_path(source);
    let mut info = if path.is_file() {
        load_cache(&path)?
    } else {
        CircuitInfo::default()
    };

    info.generated_at = timestamp(SystemTime::now());
    info.files.insert(file_key(source), measured.to_vec());

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

fn load_cache(path: &Path) -> Result<CircuitInfo, MeasureError> {
    let text = std::fs::read_to_string(path).map_err(|source| MeasureError::Read {
        path: path.to_owned(),
        source,
    })?;
    serde_json::from_str(&text).map_err(|source| MeasureError::Parse {
        path: path.to_owned(),
        source,
    })
}

/// The cache sits in the source's own directory.
#[must_use]
pub fn cache_path(source: &Path) -> PathBuf {
    source
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(CACHE_FILE_NAME)
}

/// Entries are keyed by the source's file name, not its path.
fn file_key(source: &Path) -> String {
    source
        .file_name()
        .unwrap_or_default()
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
        CACHE_FILE_NAME, Measurement, civil_date, clean, parse, read_cache, tail, timestamp,
        write_cache,
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

    #[test]
    fn a_cache_write_keeps_the_entries_of_other_sources() {
        let directory = tempfile::tempdir().expect("a temporary directory is available");
        let source = directory.path().join("MockOwnable.compact");
        std::fs::write(
            directory.path().join(CACHE_FILE_NAME),
            "{\n  \"generatedAt\": \"2026-01-01T00:00:00.000Z\",\n  \"files\": {\n    \"Other.compact\": [{ \"name\": \"run\", \"k\": 3, \"rows\": 4 }]\n  }\n}\n",
        )
        .expect("the cache is writable");

        let written = [measurement("owner", 7, 74)];
        write_cache(&source, &written).expect("the cache is writable");

        assert_eq!(
            read_cache(&source).expect("the cache is readable"),
            Some(written.to_vec())
        );
        assert_eq!(
            read_cache(&directory.path().join("Other.compact")).expect("the cache is readable"),
            Some(vec![measurement("run", 3, 4)])
        );
    }

    #[test]
    fn a_source_with_no_cache_entry_reads_as_absent() {
        let directory = tempfile::tempdir().expect("a temporary directory is available");

        assert_eq!(
            read_cache(&directory.path().join("Gone.compact")).expect("the cache is readable"),
            None
        );
    }

    #[test]
    fn a_timestamp_renders_as_utc_rfc_3339() {
        let moment = UNIX_EPOCH + Duration::from_hours(490_896);

        assert_eq!(timestamp(moment), "2026-01-01T00:00:00.000Z");
        assert_eq!(civil_date(0), (1970, 1, 1));
    }
}
