//! `compact-profile` command line entry point.

#![forbid(unsafe_code)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use compact_profile::check::{self, Analysis, CLIENT_LEDGER, ClientCheck, ClientVersion};
use compact_profile::limits::{self, Caps};
use compact_profile::profile::{self, Profile};
use compact_profile::report::{self, Reporter};
use compact_profile::snapshot::{self, Drift, Snapshot};
use compact_profile::tx;

/// Exit code for parity mismatches or snapshot drift.
const EXIT_FINDINGS: u8 = 1;

/// Exit code for a usage, input, IO or ledger error.
const EXIT_ERROR: u8 = 2;

#[derive(Debug, Parser)]
#[command(
    name = "compact-profile",
    version,
    about = "Capacity profiler for Midnight Compact contract transactions"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Write a profile's ledger parameters and print their params identity.
    Params(ParamsArgs),
    /// Cost one serialized transaction (unproven, proven or balanced) against one network.
    Cost(CostArgs),
    /// Check a manifest's scenarios against the runner's numbers and a snapshot.
    Check(RunArgs),
    /// Write the snapshot `check` compares against.
    Update(RunArgs),
}

/// Which network profiles to use.
#[derive(Debug, clap::Args)]
struct NetworkArgs {
    /// Shipped profile: mainnet, preprod or undeployed.
    #[arg(long = "network", value_name = "NAME")]
    networks: Vec<String>,

    /// Profile file; replaces the shipped profile of the same name.
    #[arg(long = "profile-file", value_name = "FILE")]
    profile_files: Vec<PathBuf>,
}

#[derive(Debug, clap::Args)]
struct ParamsArgs {
    #[command(flatten)]
    network: NetworkArgs,

    /// Write the tagged ledger parameter bytes here.
    #[arg(long, value_name = "FILE")]
    out: Option<PathBuf>,

    /// Output format: `table` prints the bare identity.
    #[arg(long, value_enum, default_value_t = Reporter::Table, value_name = "NAME")]
    reporter: Reporter,
}

#[derive(Debug, clap::Args)]
struct CostArgs {
    /// Serialized transaction, any form; a balanced one is evaluated as submitted.
    tx: PathBuf,

    #[command(flatten)]
    network: NetworkArgs,

    /// Output format.
    #[arg(long, value_enum, default_value_t = Reporter::Table, value_name = "NAME")]
    reporter: Reporter,
}

#[derive(Debug, clap::Args)]
struct RunArgs {
    /// Manifest the runner wrote.
    #[arg(long, value_name = "FILE")]
    manifest: PathBuf,

    #[command(flatten)]
    network: NetworkArgs,

    /// Snapshot to compare with (`check`) or write (`update`).
    #[arg(long, value_name = "FILE")]
    snapshot: PathBuf,

    /// Output format.
    #[arg(long, value_enum, default_value_t = Reporter::Table, value_name = "NAME")]
    reporter: Reporter,

    /// Bytes a scenario's serializedLen and blockUsage may drift before `check` fails.
    #[arg(long, default_value_t = 0, value_name = "BYTES")]
    size_tolerance: u64,
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
    match Cli::parse().command {
        Command::Params(args) => run_params(&args),
        Command::Cost(args) => run_cost(&args),
        Command::Check(args) => run_check(&args),
        Command::Update(args) => run_update(&args),
    }
}

fn run_params(args: &ParamsArgs) -> Result<ExitCode> {
    let profile = profile::select_one(&args.network.networks, &args.network.profile_files)?;
    if let Some(out) = &args.out {
        std::fs::write(out, &profile.parameter_bytes)
            .with_context(|| format!("writing {}", out.display()))?;
        eprintln!(
            "Wrote {} bytes of {} ledger parameters to {}.",
            profile.parameter_bytes.len(),
            profile.name,
            out.display()
        );
    }
    let mut out = std::io::stdout().lock();
    match args.reporter {
        Reporter::Table => writeln!(out, "{}", profile.identity),
        Reporter::Json => report::params_json(&mut out, &profile),
    }
    .context("writing the identity")?;
    Ok(ExitCode::SUCCESS)
}

fn run_cost(args: &CostArgs) -> Result<ExitCode> {
    let profile = profile::select_one(&args.network.networks, &args.network.profile_files)?;
    let bytes =
        std::fs::read(&args.tx).with_context(|| format!("reading {}", args.tx.display()))?;
    let (form, measurement) = tx::measure(&bytes, &profile.parameters)
        .with_context(|| format!("measuring {}", args.tx.display()))?;
    let evaluation = limits::evaluate_form(&measurement, &Caps::of(&profile), form);
    let mut out = std::io::stdout().lock();
    match args.reporter {
        Reporter::Table => report::cost_table(&mut out, &profile, form, &measurement, &evaluation),
        Reporter::Json => report::cost_json(&mut out, &profile, form, &measurement, &evaluation),
    }
    .context("writing the report")?;
    Ok(ExitCode::SUCCESS)
}

fn analyze(args: &RunArgs) -> Result<Analysis> {
    let profiles: Vec<Profile> =
        profile::select(&args.network.networks, &args.network.profile_files)?;
    let analysis = check::analyze(&args.manifest, profiles)?;
    warn_on_client(&analysis);
    Ok(analysis)
}

/// Warns when the manifest's client ledger is below a network's minimum, or cannot be
/// compared with one.
fn warn_on_client(analysis: &Analysis) {
    let any_minimum = analysis
        .networks
        .iter()
        .any(|network| network.profile.min_client_ledger.version.is_some());
    match &analysis.client {
        ClientVersion::Absent if any_minimum => eprintln!(
            "compact-profile: warning: the manifest's toolchain has no {CLIENT_LEDGER} \
             version, so it is not checked against the minimum client ledger."
        ),
        ClientVersion::Unparsable(text) if any_minimum => eprintln!(
            "compact-profile: warning: the manifest's {CLIENT_LEDGER} version {text:?} is not \
             a semantic version, so it is not checked against the minimum client ledger."
        ),
        _ => {}
    }
    for network in &analysis.networks {
        if let ClientCheck::BelowMinimum { used, minimum } = &network.client {
            eprintln!(
                "compact-profile: warning: the transactions were built with {CLIENT_LEDGER} \
                 {used}, below {}'s minimum client ledger {minimum}; the network may refuse \
                 what that client builds.",
                network.profile.name
            );
        }
    }
}

fn render(args: &RunArgs, analysis: &Analysis, drift: Option<&[Drift]>) -> Result<()> {
    let mut out = std::io::stdout().lock();
    match args.reporter {
        Reporter::Table => report::check_table(&mut out, analysis, drift),
        Reporter::Json => report::check_json(&mut out, analysis, drift),
    }
    .context("writing the report")
}

fn run_check(args: &RunArgs) -> Result<ExitCode> {
    let committed = Snapshot::load(&args.snapshot)?;
    let analysis = analyze(args)?;
    let drift = snapshot::compare(&committed, &Snapshot::of(&analysis), args.size_tolerance)?;
    render(args, &analysis, Some(&drift))?;
    eprintln!(
        "{} {}",
        scope_line(&analysis),
        findings_line(analysis.parity.len(), Some(&drift))
    );
    if analysis.parity.is_empty() && drift.is_empty() {
        Ok(ExitCode::SUCCESS)
    } else {
        Ok(ExitCode::from(EXIT_FINDINGS))
    }
}

fn run_update(args: &RunArgs) -> Result<ExitCode> {
    let analysis = analyze(args)?;
    if !analysis.parity.is_empty() {
        render(args, &analysis, None)?;
        eprintln!(
            "{} {} Snapshot not written.",
            scope_line(&analysis),
            findings_line(analysis.parity.len(), None)
        );
        return Ok(ExitCode::from(EXIT_FINDINGS));
    }
    Snapshot::of(&analysis).save(&args.snapshot)?;
    render(args, &analysis, None)?;
    eprintln!(
        "{} Wrote snapshot {}.",
        scope_line(&analysis),
        display(&args.snapshot)
    );
    Ok(ExitCode::SUCCESS)
}

fn display(path: &Path) -> String {
    path.display().to_string()
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

fn scope_line(analysis: &Analysis) -> String {
    format!(
        "Checked {} on {}.",
        plural(analysis.measurements.len(), "scenario", "scenarios"),
        plural(analysis.networks.len(), "network", "networks"),
    )
}

fn findings_line(parity: usize, drift: Option<&[Drift]>) -> String {
    let mut findings = Vec::new();
    if parity > 0 {
        findings.push(format!(
            "Found {}.",
            plural(parity, "parity mismatch", "parity mismatches")
        ));
    }
    match drift {
        Some(drift) if !drift.is_empty() => {
            findings.push(format!(
                "Found {}.",
                plural(drift.len(), "drifted value", "drifted values")
            ));
            let stopped = drift.iter().filter(|entry| entry.no_longer_fits()).count();
            if stopped > 0 {
                findings.push(format!(
                    "{} no longer {}.",
                    plural(stopped, "scenario", "scenarios"),
                    if stopped == 1 { "fits" } else { "fit" }
                ));
            }
        }
        Some(_) => findings.push("Snapshot matches.".to_owned()),
        None if parity == 0 => findings.push("Parity ok.".to_owned()),
        None => {}
    }
    findings.join(" ")
}

/// Prints the error and every source under it, one cause per line.
fn report_error(error: &anyhow::Error) {
    eprintln!("compact-profile: {error}");
    for cause in error.chain().skip(1) {
        eprintln!("  caused by: {cause}");
    }
}
