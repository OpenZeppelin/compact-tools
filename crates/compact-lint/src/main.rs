//! `compact-lint` command line entry point.

#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::io::{IsTerminal, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::str::FromStr;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tempfile::TempDir;

use compact_lint::check;
use compact_lint::diagnostic::{Action, Diagnostic, Level, Output, Reporter, Summary, counts};
use compact_lint::format::{COMPACT_BIN_ENV, DEFAULT_COMPACT_BIN};
use compact_lint::{diagnostic, fill, fix};

/// Exit code for a run that produced errors, or a `--dry-run` that would edit.
const EXIT_FINDINGS: u8 = 1;

/// Exit code for a usage, config, IO or parser error.
const EXIT_ERROR: u8 = 2;

/// Shown diagnostics per run, before `--max-diagnostics` changes it.
const DEFAULT_MAX_DIAGNOSTICS: &str = "20";

#[derive(Debug, Parser)]
#[command(
    name = "compact-lint",
    version,
    about = "Doc-comment linter for Compact sources"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Check doc comments against the per-kind templates in compact-lint.toml.
    Check(CheckArgs),
    /// Rewrite doc comments so the rules `fix` covers stop reporting.
    Fix(FixArgs),
    /// Measure every tagged circuit and write the values into its constraints tag.
    FillConstraints(FillArgs),
}

/// The flags every subcommand shares for what it prints and how loudly.
#[derive(Debug, clap::Args)]
struct OutputArgs {
    /// Output format.
    #[arg(long, value_enum, default_value_t = Reporter::Default, value_name = "NAME")]
    reporter: Reporter,

    /// Lowest level shown; the summary still counts what it hides.
    #[arg(long, value_enum, default_value_t = LevelArg::Info, value_name = "LEVEL")]
    diagnostic_level: LevelArg,

    /// Exit 1 when the run produced warnings but no errors.
    #[arg(long)]
    error_on_warnings: bool,

    /// Diagnostics shown before the rest are counted instead; `none` lifts the cap.
    #[arg(long, default_value = DEFAULT_MAX_DIAGNOSTICS, value_name = "NONE|N")]
    max_diagnostics: MaxDiagnostics,

    /// Colour the output; the default colours a TTY with `NO_COLOR` unset.
    #[arg(long, value_enum, value_name = "WHEN")]
    colors: Option<ColorsArg>,
}

/// The levels a reader can ask for; `off` is a rule setting, not a filter.
#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum LevelArg {
    Info,
    Warn,
    Error,
}

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
enum ColorsArg {
    Off,
    Force,
}

/// `--max-diagnostics`, either a cap or `none`.
#[derive(Clone, Copy, Debug)]
struct MaxDiagnostics(Option<usize>);

impl FromStr for MaxDiagnostics {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        if text == "none" {
            return Ok(Self(None));
        }
        text.parse()
            .map(|cap| Self(Some(cap)))
            .map_err(|_| format!("expected a whole number or `none`, got {text:?}"))
    }
}

impl OutputArgs {
    fn output(&self) -> Output {
        Output {
            reporter: self.reporter,
            level: match self.diagnostic_level {
                LevelArg::Info => Level::Info,
                LevelArg::Warn => Level::Warn,
                LevelArg::Error => Level::Error,
            },
            max: self.max_diagnostics.0,
            colors: match self.colors {
                Some(ColorsArg::Off) => false,
                Some(ColorsArg::Force) => true,
                None => std::io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none(),
            },
        }
    }
}

#[derive(Debug, clap::Args)]
struct CheckArgs {
    /// Files or directories to check; defaults to the config's include globs.
    paths: Vec<PathBuf>,

    /// Config file to use instead of searching upward for compact-lint.toml.
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,

    /// Report `k=?` / `rows=?` placeholders as errors instead of warnings.
    #[arg(long)]
    strict: bool,

    /// Skip the `compact format --check` pass.
    #[arg(long)]
    no_format: bool,

    /// Path to the `compact` binary.
    #[arg(long, value_name = "PATH", env = COMPACT_BIN_ENV)]
    compact_bin: Option<OsString>,

    #[command(flatten)]
    output: OutputArgs,
}

#[derive(Debug, clap::Args)]
struct FixArgs {
    /// Files or directories to fix; defaults to the config's include globs.
    paths: Vec<PathBuf>,

    /// Config file to use instead of searching upward for compact-lint.toml.
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,

    /// Report the edits without writing them; exits 1 when there are any.
    #[arg(long)]
    dry_run: bool,

    #[command(flatten)]
    output: OutputArgs,
}

#[derive(Debug, clap::Args)]
struct FillArgs {
    /// Files or directories to fill; defaults to the config's include globs.
    paths: Vec<PathBuf>,

    /// Config file to use instead of searching upward for compact-lint.toml.
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,

    /// Report the changes without writing them.
    #[arg(long)]
    dry_run: bool,

    /// Read the .circuit-info.json caches instead of compiling.
    #[arg(long)]
    no_compile: bool,

    /// Path to the `compact` binary.
    #[arg(long, value_name = "PATH", env = COMPACT_BIN_ENV)]
    compact_bin: Option<OsString>,

    /// Directory the compiler writes to; kept after the run when given.
    #[arg(long, value_name = "DIR")]
    artifacts: Option<PathBuf>,

    #[command(flatten)]
    output: OutputArgs,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(error) => {
            report_error(&error);
            ExitCode::from(EXIT_ERROR)
        }
    }
}

fn run() -> Result<ExitCode> {
    let cli = Cli::parse();
    let cwd = std::env::current_dir().context("reading the current directory")?;

    match cli.command {
        Command::Check(args) => run_check(args, &cwd),
        Command::Fix(args) => run_fix(args, &cwd),
        Command::FillConstraints(args) => run_fill(args, &cwd),
    }
}

fn run_check(args: CheckArgs, cwd: &std::path::Path) -> Result<ExitCode> {
    let options = check::Options {
        paths: args.paths,
        config_path: args.config,
        strict: args.strict,
        no_format: args.no_format,
        compact_bin: args
            .compact_bin
            .unwrap_or_else(|| OsString::from(DEFAULT_COMPACT_BIN)),
    };

    let started = Instant::now();
    let outcome = check::run(&options, cwd).context("running the check")?;
    let (errors, warnings) = emit(
        &args.output,
        &outcome.diagnostics,
        RunFacts {
            files: outcome.files_checked,
            duration: started.elapsed(),
            action: Action::NoFixes,
        },
    )
    .context("writing the report")?;

    Ok(exit_code(errors, warnings, args.output.error_on_warnings))
}

fn run_fix(args: FixArgs, cwd: &std::path::Path) -> Result<ExitCode> {
    let options = fix::Options {
        paths: args.paths,
        config_path: args.config,
        dry_run: args.dry_run,
    };

    let started = Instant::now();
    let outcome = fix::run(&options, cwd).context("running the fix")?;
    let action = if options.dry_run {
        Action::NoFixes
    } else {
        Action::Fixed(outcome.changed)
    };
    let (errors, warnings) = emit(
        &args.output,
        &outcome.diagnostics,
        RunFacts {
            files: outcome.checked,
            duration: started.elapsed(),
            action,
        },
    )
    .context("writing the report")?;

    if options.dry_run && outcome.edits() > 0 {
        return Ok(ExitCode::from(EXIT_FINDINGS));
    }
    Ok(exit_code(errors, warnings, args.output.error_on_warnings))
}

fn run_fill(args: FillArgs, cwd: &std::path::Path) -> Result<ExitCode> {
    let (artifacts, temporary) = artifacts_dir(args.artifacts)?;

    let options = fill::Options {
        paths: args.paths,
        config_path: args.config,
        dry_run: args.dry_run,
        no_compile: args.no_compile,
        compact_bin: args
            .compact_bin
            .unwrap_or_else(|| OsString::from(DEFAULT_COMPACT_BIN)),
        artifacts,
    };

    let started = Instant::now();
    let outcome = fill::run(&options, cwd).context("filling the constraints")?;
    let (errors, warnings) = emit(
        &args.output,
        &outcome.diagnostics,
        RunFacts {
            files: outcome.checked,
            duration: started.elapsed(),
            action: Action::Filled {
                values: outcome.filled,
                files: outcome.files,
            },
        },
    )
    .context("writing the report")?;

    drop(temporary);
    if outcome.unmeasured > 0 {
        return Ok(ExitCode::from(EXIT_FINDINGS));
    }
    Ok(exit_code(errors, warnings, args.output.error_on_warnings))
}

/// The artifacts directory, plus the temporary one to remove once the run ends.
fn artifacts_dir(given: Option<PathBuf>) -> Result<(PathBuf, Option<TempDir>)> {
    if let Some(path) = given {
        return Ok((path, None));
    }

    let directory = tempfile::tempdir().context("creating the artifacts directory")?;
    Ok((directory.path().to_owned(), Some(directory)))
}

/// What a run did, everything the summary needs that the diagnostics do not carry.
#[derive(Clone, Copy, Debug)]
struct RunFacts {
    files: usize,
    duration: Duration,
    action: Action,
}

/// Writes the diagnostics to stdout and the truncation notice and summary to stderr.
fn emit(
    args: &OutputArgs,
    diagnostics: &[Diagnostic],
    facts: RunFacts,
) -> std::io::Result<(usize, usize)> {
    let (errors, warnings) = counts(diagnostics);

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let hidden = args.output().render(&mut out, diagnostics)?;

    let stderr = std::io::stderr();
    let mut error_out = stderr.lock();
    if hidden > 0 {
        writeln!(error_out, "{}", diagnostic::truncation(hidden))?;
    }
    writeln!(
        error_out,
        "{}",
        Summary {
            files: facts.files,
            duration: facts.duration,
            action: facts.action,
            errors,
            warnings,
        }
        .render()
    )?;

    Ok((errors, warnings))
}

fn exit_code(errors: usize, warnings: usize, error_on_warnings: bool) -> ExitCode {
    if errors > 0 || (error_on_warnings && warnings > 0) {
        ExitCode::from(EXIT_FINDINGS)
    } else {
        ExitCode::SUCCESS
    }
}

/// Prints the error and every source under it, one cause per line.
fn report_error(error: &anyhow::Error) {
    eprintln!("compact-lint: {error}");
    for cause in error.chain().skip(1) {
        eprintln!("  caused by: {cause}");
    }
}
