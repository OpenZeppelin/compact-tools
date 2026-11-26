//! `compact-mock` command line entry point.

#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use compact_mock::config::{self, Paths};
use compact_mock::error::{ConfigError, Error};
use compact_mock::output::{self, Drift, Written};
use compact_mock::plan;
use compact_mock::scope::Files;

/// Exit code for `--check` drift.
const EXIT_DRIFT: u8 = 1;

/// Exit code for a usage, config, IO, parse or planning error.
const EXIT_ERROR: u8 = 2;

#[derive(Debug, Parser)]
#[command(
    name = "compact-mock",
    version,
    about = "Mock contract generator for Compact modules"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Generate the mocks compact-mock.toml describes, or check them with --check.
    Generate(GenerateArgs),
}

#[derive(Debug, clap::Args)]
struct GenerateArgs {
    /// Generated mock names to restrict the run to; all mocks when none is given.
    #[arg(value_name = "NAME")]
    names: Vec<String>,

    /// Config file to use instead of searching upward for compact-mock.toml.
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,

    /// Write nothing; exit 1 when a generated file is missing or differs.
    #[arg(long)]
    check: bool,
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            let code = if error.use_stderr() { EXIT_ERROR } else { 0 };
            // A failed print leaves nothing better to do than exit.
            let _ = error.print();
            return ExitCode::from(code);
        }
    };
    let Command::Generate(args) = cli.command;
    match std::env::current_dir() {
        Ok(cwd) => generate(&args, &cwd),
        Err(source) => {
            report(&[Error::from(compact_mock::error::OutputError::Read {
                path: ".".to_owned(),
                source,
            })]);
            ExitCode::from(EXIT_ERROR)
        }
    }
}

fn generate(args: &GenerateArgs, cwd: &Path) -> ExitCode {
    let paths = Paths {
        cwd: config::normalize(cwd),
    };
    let targets = match prepare(args, &paths) {
        Ok(targets) => targets,
        Err(errors) => {
            report(&errors);
            return ExitCode::from(EXIT_ERROR);
        }
    };
    if args.check {
        check(&targets)
    } else {
        write(&targets)
    }
}

/// Everything before the first write: config, expansion, plans and ownership. Every
/// error is collected, each mock's plan errors before its ownership error.
fn prepare(args: &GenerateArgs, paths: &Paths) -> Result<Vec<output::Target>, Vec<Error>> {
    let config_path = match &args.config {
        Some(path) => path.clone(),
        None => config::discover(&paths.cwd).ok_or_else(|| {
            vec![Error::from(ConfigError::NotFound {
                cwd: paths.cwd.display().to_string(),
            })]
        })?,
    };
    let config = config::load(&config_path, paths)?;
    let mut names: Vec<String> = Vec::new();
    for name in &args.names {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    let mut files = Files::new(paths.clone());
    let outcome = plan::plan(&config, &mut files, &names);
    let mut errors = outcome.errors;
    let mut targets = Vec::new();
    for mock in outcome.mocks {
        match mock.map(|plan| output::target(&plan, paths)) {
            Ok(Ok(target)) => targets.push(target),
            Ok(Err(error)) => errors.push(error.into()),
            Err(mut found) => errors.append(&mut found),
        }
    }
    if errors.is_empty() {
        Ok(targets)
    } else {
        Err(errors)
    }
}

fn write(targets: &[output::Target]) -> ExitCode {
    let mut written = 0;
    for target in targets {
        match output::write(target) {
            Ok(Written::Wrote) => {
                written += 1;
                println!("wrote {}", target.shown);
            }
            Ok(Written::Unchanged) => println!("unchanged {}", target.shown),
            Err(error) => {
                report(&[error.into()]);
                return ExitCode::from(EXIT_ERROR);
            }
        }
    }
    eprintln!(
        "compact-mock: {}, {written} written, {} unchanged.",
        count(targets.len()),
        targets.len() - written
    );
    ExitCode::SUCCESS
}

fn check(targets: &[output::Target]) -> ExitCode {
    let mut drifted = 0;
    for target in targets {
        match output::drift(target) {
            Drift::Clean => {}
            Drift::Missing => {
                drifted += 1;
                println!("missing {}", target.shown);
            }
            Drift::Changed(diff) => {
                drifted += 1;
                println!("changed {}", target.shown);
                print!("{diff}");
            }
        }
    }
    if drifted == 0 {
        eprintln!("compact-mock: {} up to date.", count(targets.len()));
        ExitCode::SUCCESS
    } else {
        eprintln!(
            "compact-mock: {drifted} of {} out of date; run compact-mock generate.",
            count(targets.len())
        );
        ExitCode::from(EXIT_DRIFT)
    }
}

fn count(mocks: usize) -> String {
    if mocks == 1 {
        "1 mock".to_owned()
    } else {
        format!("{mocks} mocks")
    }
}

/// Prints each error with its causes, then a count when there is more than one.
fn report(errors: &[Error]) {
    for error in errors {
        eprintln!("compact-mock: {error}");
        let mut cause = std::error::Error::source(error);
        while let Some(inner) = cause {
            eprintln!("  caused by: {inner}");
            cause = inner.source();
        }
    }
    if errors.len() > 1 {
        eprintln!("compact-mock: {} errors; nothing written.", errors.len());
    }
}
