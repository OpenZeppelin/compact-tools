//! `build`: compiles each generated mock with the `compact` toolchain.

use std::ffi::OsString;
use std::io::Write;
use std::process::Command;

use crate::config::Paths;
use crate::error::BuildError;
use crate::plan::MockPlan;

/// Env var naming the `compact` executable.
pub const COMPACT_BIN_ENV: &str = "COMPACT_MOCK_COMPACT_BIN";

/// How to run `compact compile`.
#[derive(Clone, Debug)]
pub struct Options {
    /// `+<VERSION>`, without the `+`.
    pub version: Option<String>,
    pub skip_zk: bool,
    pub compact_bin: OsString,
}

/// The arguments after the executable: `compile [+<V>] [--skip-zk] <src> <out>`.
#[must_use]
pub fn arguments(plan: &MockPlan, options: &Options, paths: &Paths) -> Vec<String> {
    let mut args = vec!["compile".to_owned()];
    if let Some(version) = &options.version {
        args.push(format!("+{version}"));
    }
    if options.skip_zk {
        args.push("--skip-zk".to_owned());
    }
    args.push(paths.show(&plan.path));
    args.push(paths.show(&plan.artifacts.join(&plan.name)));
    args
}

/// Compiles one mock into `<artifacts>/<name>/`. On failure compactc's output is copied
/// to stderr verbatim.
/// # Errors
/// Returns [`BuildError::CannotRun`] when the executable does not start, and
/// [`BuildError::Failed`] when it exits non-zero.
pub fn compile(plan: &MockPlan, options: &Options, paths: &Paths) -> Result<(), BuildError> {
    let output = Command::new(&options.compact_bin)
        .args(arguments(plan, options, paths))
        .output()
        .map_err(|source| BuildError::CannotRun {
            bin: options.compact_bin.to_string_lossy().into_owned(),
            source,
        })?;
    if output.status.success() {
        return Ok(());
    }
    let mut stderr = std::io::stderr().lock();
    // A failed copy leaves the failure message, which still prints.
    let _ = stderr.write_all(&output.stdout);
    let _ = stderr.write_all(&output.stderr);
    Err(BuildError::Failed {
        path: paths.show(&plan.path),
        code: output
            .status
            .code()
            .map_or_else(|| "signal".to_owned(), |code| code.to_string()),
    })
}

/// Whether `SKIP_ZK` asks for `--skip-zk`, as `compact-compiler` reads it.
#[must_use]
pub fn skip_zk_from_env() -> bool {
    std::env::var("SKIP_ZK").is_ok_and(|value| value == "true")
}
