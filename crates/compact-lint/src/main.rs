//! `compact-lint` command line entry point.

#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use compact_lint::check::{self, Options, Outcome};
use compact_lint::format::{COMPACT_BIN_ENV, DEFAULT_COMPACT_BIN};

/// Exit code for a run that produced findings.
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
    let Command::Check(args) = cli.command;

    let cwd = std::env::current_dir().context("reading the current directory")?;
    let options = Options {
        paths: args.paths,
        config_path: args.config,
        strict: args.strict,
        no_format: args.no_format,
        compact_bin: args
            .compact_bin
            .unwrap_or_else(|| OsString::from(DEFAULT_COMPACT_BIN)),
    };

    let outcome = check::run(&options, &cwd).context("running the check")?;
    emit(&outcome).context("writing the report")?;

    Ok(if outcome.findings.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(EXIT_FINDINGS)
    })
}

fn emit(outcome: &Outcome) -> std::io::Result<()> {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for finding in &outcome.findings {
        writeln!(out, "{finding}")?;
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
