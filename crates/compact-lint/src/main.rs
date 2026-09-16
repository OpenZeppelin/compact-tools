//! `compact-lint` command line entry point.

#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tempfile::TempDir;

use compact_lint::check::{self, Outcome};
use compact_lint::format::{COMPACT_BIN_ENV, DEFAULT_COMPACT_BIN};
use compact_lint::{fill, fix};

/// Exit code for a run that produced findings, or a `--dry-run` that would edit.
const EXIT_FINDINGS: u8 = 1;

/// Exit code for a usage, config, IO or parser error.
const EXIT_ERROR: u8 = 2;

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

#[derive(Debug, clap::Args)]
struct CheckArgs {
    /// Files or directories to check; defaults to the config's include globs.
    paths: Vec<PathBuf>,

    /// Config file to use instead of searching upward for compact-lint.toml.
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,

    /// Report `k=?` / `rows=?` placeholders in the constraints tag.
    #[arg(long)]
    strict: bool,

    /// Skip the `compact format --check` pass.
    #[arg(long)]
    no_format: bool,

    /// Path to the `compact` binary.
    #[arg(long, value_name = "PATH", env = COMPACT_BIN_ENV)]
    compact_bin: Option<OsString>,
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

    let outcome = check::run(&options, cwd).context("running the check")?;
    emit_findings(&outcome).context("writing the report")?;

    Ok(if outcome.findings.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(EXIT_FINDINGS)
    })
}

fn run_fix(args: FixArgs, cwd: &std::path::Path) -> Result<ExitCode> {
    let options = fix::Options {
        paths: args.paths,
        config_path: args.config,
        dry_run: args.dry_run,
    };

    let outcome = fix::run(&options, cwd).context("running the fix")?;
    emit_edits(&outcome).context("writing the report")?;

    Ok(if options.dry_run && outcome.edits() > 0 {
        ExitCode::from(EXIT_FINDINGS)
    } else {
        ExitCode::SUCCESS
    })
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

    let outcome = fill::run(&options, cwd).context("filling the constraints")?;
    emit_lines(&outcome.lines, &outcome.summary()).context("writing the report")?;

    drop(temporary);
    Ok(if outcome.unmeasured == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(EXIT_FINDINGS)
    })
}

/// The artifacts directory, plus the temporary one to remove once the run ends.
fn artifacts_dir(given: Option<PathBuf>) -> Result<(PathBuf, Option<TempDir>)> {
    if let Some(path) = given {
        return Ok((path, None));
    }

    let directory = tempfile::tempdir().context("creating the artifacts directory")?;
    Ok((directory.path().to_owned(), Some(directory)))
}

fn emit_lines(lines: &[String], summary: &str) -> std::io::Result<()> {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in lines {
        writeln!(out, "{line}")?;
    }
    out.flush()?;

    eprintln!("{summary}");
    Ok(())
}

fn emit_findings(outcome: &Outcome) -> std::io::Result<()> {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for finding in &outcome.findings {
        writeln!(out, "{finding}")?;
    }
    out.flush()?;

    eprintln!("{}", outcome.summary());
    Ok(())
}

fn emit_edits(outcome: &fix::Outcome) -> std::io::Result<()> {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for file in &outcome.files {
        for edit in &file.edits {
            writeln!(
                out,
                "{}",
                fix::line(&file.path, edit.position, &edit.message)
            )?;
        }
    }
    out.flush()?;

    eprintln!("{}", outcome.summary());
    Ok(())
}

/// Prints the error and every source under it, one cause per line.
fn report_error(error: &anyhow::Error) {
    eprintln!("compact-lint: {error}");
    for cause in error.chain().skip(1) {
        eprintln!("  caused by: {cause}");
    }
}
