//! `compact-mock` command line entry point.

#![forbid(unsafe_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};

use compact_mock::build::{self, COMPACT_BIN_ENV};
use compact_mock::config::{self, Config, Paths};
use compact_mock::error::{ConfigError, Error, OutputError};
use compact_mock::output::{self, Target, Written};
use compact_mock::own::{self, Produced};
use compact_mock::plan::{self, Analysis, MockPlan, Scope, Status};
use compact_mock::scope::Files;

/// Exit code for a `compact compile` failure.
const EXIT_COMPILE: u8 = 1;

/// Exit code for a usage, config, IO, parse, planning or ownership error.
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
    /// Write the mocks the [mock] table of compact.toml describes.
    Generate(Selection),
    /// Generate, then compile each mock with `compact compile`.
    Build(BuildArgs),
}

#[derive(Debug, clap::Args)]
struct Selection {
    /// Generated mock names to restrict the run to; all mocks when none is given.
    #[arg(value_name = "NAME")]
    names: Vec<String>,

    /// TOML file holding [mock], instead of the nearest compact.toml upward.
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,

    /// Only mocks of modules under this directory; stale removal stays inside it.
    #[arg(long, value_name = "DIR")]
    dir: Option<PathBuf>,
}

#[derive(Debug, clap::Args)]
struct BuildArgs {
    /// `+<VERSION>` for the toolchain, then mock names.
    #[arg(value_name = "+VERSION | NAME")]
    positional: Vec<String>,

    /// TOML file holding [mock], instead of the nearest compact.toml upward.
    #[arg(long, value_name = "FILE")]
    config: Option<PathBuf>,

    /// Only mocks of modules under this directory; stale removal stays inside it.
    #[arg(long, value_name = "DIR")]
    dir: Option<PathBuf>,

    /// Pass --skip-zk to compact compile. `SKIP_ZK=true` does the same.
    #[arg(long)]
    skip_zk: bool,

    /// The `compact` executable.
    #[arg(long, value_name = "PATH", env = COMPACT_BIN_ENV, default_value = "compact")]
    compact_bin: OsString,
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
    let cwd = match std::env::current_dir() {
        Ok(cwd) => config::normalize(&cwd),
        Err(source) => {
            report(&[Error::from(OutputError::Read {
                path: ".".to_owned(),
                source,
            })]);
            return ExitCode::from(EXIT_ERROR);
        }
    };
    let paths = Paths { cwd };
    match cli.command {
        Command::Generate(selection) => match generate(&selection, &paths) {
            Ok(_) => ExitCode::SUCCESS,
            Err(code) => code,
        },
        Command::Build(args) => run_build(args, &paths),
    }
}

fn run_build(args: BuildArgs, paths: &Paths) -> ExitCode {
    let mut version = None;
    let mut names = Vec::new();
    for value in args.positional {
        match value.strip_prefix('+') {
            Some(_) if version.is_some() => {
                eprintln!("compact-mock: build takes at most one +<VERSION>");
                return ExitCode::from(EXIT_ERROR);
            }
            Some(text) => version = Some(text.to_owned()),
            None => names.push(value),
        }
    }
    let selection = Selection {
        names,
        config: args.config,
        dir: args.dir,
    };
    let plans = match generate(&selection, paths) {
        Ok(plans) => plans,
        Err(code) => return code,
    };
    let options = build::Options {
        version,
        skip_zk: args.skip_zk || build::skip_zk_from_env(),
        compact_bin: args.compact_bin,
    };
    let mut out = io::stdout().lock();
    for plan in &plans {
        if let Err(error) = build::compile(plan, &options, paths) {
            let failed = matches!(error, compact_mock::error::BuildError::Failed { .. });
            report(&[error.into()]);
            return ExitCode::from(if failed { EXIT_COMPILE } else { EXIT_ERROR });
        }
        if writeln!(
            out,
            "compiled {}",
            paths.show(&plan.artifacts.join(&plan.name))
        )
        .is_err()
        {
            report(&[OutputError::Stdout {
                source: io::Error::other("stdout closed"),
            }
            .into()]);
            return ExitCode::from(EXIT_ERROR);
        }
    }
    let _ = out.flush();
    eprintln!("compact-mock: {} compiled.", count(plans.len()));
    ExitCode::SUCCESS
}

/// Runs `generate` and returns the plans it wrote, in expansion order.
#[allow(
    clippy::too_many_lines,
    reason = "plan, own, write and print run in order"
)]
fn generate(selection: &Selection, paths: &Paths) -> Result<Vec<MockPlan>, ExitCode> {
    let fail = |errors: &[Error]| {
        report(errors);
        ExitCode::from(EXIT_ERROR)
    };
    let config = load(selection, paths).map_err(|errors| fail(&errors))?;
    let dir = match &selection.dir {
        Some(dir) => {
            let absolute = paths.absolute(dir);
            if !absolute.is_dir() {
                return Err(fail(&[ConfigError::DirMissing {
                    dir: dir.display().to_string(),
                }
                .into()]));
            }
            Some(absolute)
        }
        None => None,
    };
    let mut names: Vec<String> = Vec::new();
    for name in &selection.names {
        if !names.contains(name) {
            names.push(name.clone());
        }
    }
    let mut files = Files::new(paths.clone());
    let analysis = plan::analyze(
        &config,
        &mut files,
        Scope {
            dir: dir.as_deref(),
            names: &names,
        },
    );

    for note in &analysis.notes {
        eprintln!("compact-mock: {note}");
    }
    for module in &analysis.modules {
        if let (true, Status::Skipped(reason)) = (module.in_scope, &module.status) {
            eprintln!("compact-mock: skipped {}: {}", module.module, reason.text());
        }
    }
    let fatal = analysis.fatal();
    if !fatal.is_empty() {
        report_refs(&fatal);
        return Err(ExitCode::from(EXIT_ERROR));
    }

    let plans: Vec<MockPlan> = analysis.plans().into_iter().cloned().collect();
    let mut targets: Vec<Target> = Vec::new();
    let mut errors: Vec<Error> = Vec::new();
    for plan in &plans {
        match output::target(plan, paths) {
            Ok(target) => targets.push(target),
            Err(error) => errors.push(error.into()),
        }
    }
    let produced = produced(
        &config,
        &analysis,
        &targets,
        dir.as_deref(),
        names.is_empty(),
    );
    let own_plan = match own::plan(&produced, paths) {
        Ok(own_plan) => own_plan,
        Err(found) => {
            errors.extend(found.into_iter().map(Error::from));
            own::OwnPlan::default()
        }
    };
    if !errors.is_empty() {
        return Err(fail(&errors));
    }

    let outcome = own::execute(&own_plan, &targets, paths, &mut |_| Ok(()));
    let done = match outcome {
        Ok(done) => done,
        Err(error) => return Err(fail(&[error.into()])),
    };
    let mut out = io::stdout().lock();
    let mut printed = Ok(());
    let mut written = 0;
    for (shown, what) in &done.targets {
        let verb = match what {
            Written::Wrote => {
                written += 1;
                "wrote"
            }
            Written::Unchanged => "unchanged",
        };
        if printed.is_ok() {
            printed = writeln!(out, "{verb} {shown}");
        }
    }
    for shown in &done.removed {
        if printed.is_ok() {
            printed = writeln!(out, "removed {shown}");
        }
    }
    if let Err(source) = printed.and_then(|()| out.flush()) {
        return Err(fail(&[OutputError::Stdout { source }.into()]));
    }
    eprintln!(
        "compact-mock: {}, {written} written, {} unchanged, {} removed.",
        count(targets.len()),
        targets.len() - written,
        done.removed.len()
    );
    Ok(plans)
}

fn load(selection: &Selection, paths: &Paths) -> Result<Config, Vec<Error>> {
    let config_path = match &selection.config {
        Some(path) => path.clone(),
        None => config::discover(&paths.cwd).ok_or_else(|| {
            vec![Error::from(ConfigError::NotFound {
                cwd: paths.cwd.display().to_string(),
            })]
        })?,
    };
    config::load(&config_path, paths)
}

/// What the run writes, what the full expansion produces per directory, and where
/// deletion is allowed.
fn produced(
    config: &Config,
    analysis: &Analysis,
    targets: &[Target],
    dir: Option<&Path>,
    delete: bool,
) -> Produced {
    let mut written: BTreeMap<PathBuf, BTreeSet<String>> = BTreeMap::new();
    for target in targets {
        written
            .entry(target.artifacts.clone())
            .or_default()
            .insert(target.name.clone());
    }
    let mut expansion: BTreeMap<PathBuf, BTreeSet<String>> = BTreeMap::new();
    let mut unsure: BTreeSet<PathBuf> = BTreeSet::new();
    for module in &analysis.modules {
        match &module.status {
            Status::Mocks {
                names,
                artifacts,
                errors,
                ..
            } => {
                expansion
                    .entry(artifacts.clone())
                    .or_default()
                    .extend(names.iter().cloned());
                if !errors.is_empty() {
                    unsure.insert(artifacts.clone());
                }
            }
            Status::Failed(_) => {
                unsure.insert(config.artifacts_dir(&module.module));
            }
            _ => {}
        }
    }
    let examine = delete.then(|| match dir {
        None => Some(config.src.clone()),
        Some(dir) if dir.starts_with(&config.src) => Some(dir.to_owned()),
        Some(dir) if config.src.starts_with(dir) => Some(config.src.clone()),
        Some(_) => None,
    });
    Produced {
        written,
        expansion,
        unsure,
        examine: examine.flatten(),
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
    report_refs(&errors.iter().collect::<Vec<_>>());
}

fn report_refs(errors: &[&Error]) {
    for error in errors {
        eprintln!("compact-mock: {error}");
        let mut cause = std::error::Error::source(*error);
        while let Some(inner) = cause {
            eprintln!("  caused by: {inner}");
            cause = inner.source();
        }
    }
    if errors.len() > 1 {
        eprintln!("compact-mock: {} errors; nothing written.", errors.len());
    }
}
