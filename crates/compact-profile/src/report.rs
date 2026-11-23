//! Reporters: a fixed-column table for people and JSON for the runner.

use std::collections::BTreeMap;
use std::io::{self, Write};

use serde::Serialize;
use serde_json::Value;

use crate::block::{Binding, Capacity, Conflict, Count};
use crate::check::{Analysis, ClientCheck, NetworkResult, ParityMismatch};
use crate::cost::{Cost, Measurement};
use crate::fit::Largest;
use crate::limits::{Check, Evaluation, Limit, ProofBytes, Ratio, Scope, Status};
use crate::profile::Profile;
use crate::series::{Basis, SeriesCapacity};
use crate::snapshot::{Change, Drift};
use crate::tx::Form;

/// Hex digits of the params identity the table shows.
const IDENTITY_PREFIX: usize = 16;

/// The label on a network whose minimum client ledger the manifest's is below.
pub const CLIENT_BELOW_MINIMUM: &str = "client below minimum";

fn min_client_ledger(profile: &Profile) -> Option<String> {
    profile
        .min_client_ledger
        .version
        .as_ref()
        .map(ToString::to_string)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParamsJson<'a> {
    network: &'a str,
    provisional: bool,
    node_release: Option<&'a str>,
    ledger_crate: &'a str,
    params_identity: &'a str,
    min_client_ledger: Option<String>,
}

/// The `params --reporter json` object.
///
/// # Errors
///
/// Writing to `out` fails.
pub fn params_json(out: &mut impl Write, profile: &Profile) -> io::Result<()> {
    write_json(
        out,
        &ParamsJson {
            network: &profile.name,
            provisional: profile.provisional,
            node_release: profile.node_release.as_deref(),
            ledger_crate: &profile.ledger_crate,
            params_identity: profile.identity.as_str(),
            min_client_ledger: min_client_ledger(profile),
        },
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Reporter {
    Table,
    Json,
}

/// `1234567` as `1,234,567`.
#[must_use]
pub fn group(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(digit);
    }
    out
}

/// A float with two decimals and thousands separators.
#[must_use]
pub fn group_decimal(value: f64) -> String {
    let text = format!("{:.2}", value.abs());
    let (whole, fraction) = text.split_once('.').unwrap_or((&text, "00"));
    let grouped = whole
        .parse::<u64>()
        .map_or_else(|_| whole.to_owned(), group);
    // A value that rounds to zero prints without a sign.
    let negative = value < 0.0 && text.bytes().any(|byte| matches!(byte, b'1'..=b'9'));
    let sign = if negative { "-" } else { "" };
    format!("{sign}{grouped}.{fraction}")
}

/// Parts per million as a percentage with two decimals, truncated.
#[must_use]
pub fn percent(ppm: u64) -> String {
    if ppm == u64::MAX {
        return "inf".to_owned();
    }
    format!("{}.{:02}%", ppm / 10_000, ppm % 10_000 / 100)
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

fn or_dash(value: Option<u64>) -> String {
    value.map_or_else(|| "-".to_owned(), group)
}

#[derive(Clone, Copy)]
enum Align {
    Left,
    Right,
}

/// Columns padded to their widest cell and joined by two spaces, without trailing blanks.
fn table(
    out: &mut impl Write,
    indent: &str,
    columns: &[(&str, Align)],
    rows: &[Vec<String>],
) -> io::Result<()> {
    let widths: Vec<usize> = columns
        .iter()
        .enumerate()
        .map(|(index, (header, _))| {
            rows.iter()
                .map(|row| row[index].chars().count())
                .chain([header.chars().count()])
                .max()
                .unwrap_or(0)
        })
        .collect();
    let headers: Vec<String> = columns
        .iter()
        .map(|(header, _)| (*header).to_owned())
        .collect();
    for row in std::iter::once(&headers).chain(rows) {
        let cells: Vec<String> = row
            .iter()
            .zip(columns)
            .zip(&widths)
            .map(|((cell, (_, align)), width)| match align {
                Align::Left => format!("{cell:<width$}"),
                Align::Right => format!("{cell:>width$}"),
            })
            .collect();
        writeln!(out, "{indent}{}", cells.join("  ").trim_end())?;
    }
    Ok(())
}

fn network_line(profile: &Profile, scope: Scope) -> String {
    let mut facts = vec![format!(
        "node {}",
        profile.node_release.as_deref().unwrap_or("unknown")
    )];
    facts.push(profile.ledger_crate.clone());
    facts.push(format!("captured {}", profile.captured));
    facts.push(scope.name().to_owned());
    if profile.provisional {
        facts.push("provisional".to_owned());
    }
    format!("{}: {}", profile.name, facts.join(", "))
}

fn binding_cell(check: Option<&Check>) -> (String, String) {
    match check {
        Some(check) => (
            check.limit.name().to_owned(),
            check
                .ratio()
                .map_or_else(|| "-".to_owned(), |ratio| percent(ratio.ppm())),
        ),
        None => ("-".to_owned(), "-".to_owned()),
    }
}

fn largest_cell(largest: Option<Largest>) -> String {
    match largest {
        None => "n/a".to_owned(),
        Some(Largest::Unbounded) => "unbounded".to_owned(),
        Some(Largest::Max(n)) => group(n),
    }
}

fn counted(count: u64, noun: &str) -> String {
    let suffix = if count == 1 { "" } else { "s" };
    format!("{} {noun}{suffix}", group(count))
}

fn proof_term_line(measurement: &Measurement, evaluation: &Evaluation) -> String {
    match evaluation.proof {
        ProofBytes::Added(bytes) => format!(
            "+{} bytes for {} and {}",
            group(bytes),
            counted(measurement.proofs.calls, "call proof"),
            counted(measurement.proofs.builtin, "built-in proof"),
        ),
        ProofBytes::Proven => "none, the transaction holds its proofs".to_owned(),
        ProofBytes::Unknown => "unknown to the profile, sizes are the ledger's estimate".to_owned(),
    }
}

fn balancing_term_line(measurement: &Measurement, evaluation: &Evaluation) -> String {
    match (evaluation.balancing, evaluation.scope) {
        (Some(bytes), _) => format!(
            "+{} bytes for {}",
            group(bytes),
            counted(measurement.intents, "intent")
        ),
        (None, Scope::AsSubmitted) => "none, the transaction is balanced".to_owned(),
        (None, _) => {
            "unknown to the profile, results cover the contract's transaction alone".to_owned()
        }
    }
}

/// The `cost` table: the transaction's sizes, both terms, then every limit.
///
/// # Errors
///
/// Writing to `out` fails.
pub fn cost_table(
    out: &mut impl Write,
    profile: &Profile,
    form: Form,
    measurement: &Measurement,
    evaluation: &Evaluation,
) -> io::Result<()> {
    writeln!(out, "{}", network_line(profile, evaluation.scope))?;
    writeln!(
        out,
        "{form}: serialized {} bytes, estimated {} bytes, {} declared nodes; times in picoseconds",
        group(measurement.serialized_len),
        group(measurement.estimated_size()),
        group(u64::from(measurement.declared_nodes)),
    )?;
    writeln!(
        out,
        "proof term: {}",
        proof_term_line(measurement, evaluation)
    )?;
    writeln!(
        out,
        "balancing term: {}",
        balancing_term_line(measurement, evaluation)
    )?;
    let rows: Vec<Vec<String>> = evaluation
        .checks
        .iter()
        .map(|check| {
            vec![
                check.limit.name().to_owned(),
                or_dash(check.used),
                or_dash(check.allowed),
                check
                    .ratio()
                    .map_or_else(|| "-".to_owned(), |ratio| percent(ratio.ppm())),
                check.status().label().to_owned(),
            ]
        })
        .collect();
    table(
        out,
        "",
        &[
            ("limit", Align::Left),
            ("used", Align::Right),
            ("allowed", Align::Right),
            ("used%", Align::Right),
            ("status", Align::Left),
        ],
        &rows,
    )?;
    let (binding, ratio) = binding_cell(evaluation.binding());
    writeln!(
        out,
        "fits: {}, binding {binding} ({ratio})",
        yes_no(evaluation.fits())
    )
}

/// The `check` and `update` table. `drift` is `None` for `update`.
///
/// # Errors
///
/// Writing to `out` fails.
pub fn check_table(
    out: &mut impl Write,
    analysis: &Analysis,
    drift: Option<&[Drift]>,
) -> io::Result<()> {
    let manifest = &analysis.manifest;
    writeln!(out, "contract {}", manifest.contract)?;
    let identity = &manifest.params_identity;
    writeln!(
        out,
        "params identity {}",
        identity.get(..IDENTITY_PREFIX).unwrap_or(identity)
    )?;
    let toolchain: Vec<String> = manifest
        .toolchain
        .iter()
        .map(|(tool, version)| format!("{tool} {version}"))
        .collect();
    writeln!(out, "toolchain {}", toolchain.join(", "))?;
    parity_section(out, analysis)?;
    for network in &analysis.networks {
        writeln!(out)?;
        network_section(out, analysis, network)?;
    }
    for series in &analysis.series {
        writeln!(out)?;
        let sizes: Vec<String> = series.fit.sizes.iter().map(|n| group(*n)).collect();
        writeln!(out, "fit {} (n = {})", series.name, sizes.join(", "))?;
        let rows: Vec<Vec<String>> = series
            .fit
            .lines
            .iter()
            .map(|(metric, line)| {
                vec![
                    metric.name().to_owned(),
                    group_decimal(line.fixed),
                    group_decimal(line.per_item),
                    group_decimal(line.max_residual),
                ]
            })
            .collect();
        if rows.is_empty() {
            writeln!(out, "  one size; no line")?;
        } else {
            table(
                out,
                "  ",
                &[
                    ("metric", Align::Left),
                    ("fixed", Align::Right),
                    ("per n", Align::Right),
                    ("max resid", Align::Right),
                ],
                &rows,
            )?;
        }
    }
    if let Some(drift) = drift {
        writeln!(out)?;
        if drift.is_empty() {
            writeln!(out, "snapshot matches")?;
        } else {
            writeln!(out, "snapshot drift ({})", drift.len())?;
            for entry in drift {
                writeln!(out, "  {entry}")?;
            }
        }
    }
    Ok(())
}

fn parity_section(out: &mut impl Write, analysis: &Analysis) -> io::Result<()> {
    let count = analysis.measurements.len();
    if analysis.parity.is_empty() {
        return writeln!(out, "parity ok ({count} transactions)");
    }
    writeln!(
        out,
        "parity FAILED ({} of {count} transactions)",
        analysis
            .parity
            .iter()
            .map(|mismatch| &mismatch.scenario)
            .collect::<std::collections::BTreeSet<_>>()
            .len()
    )?;
    let rows: Vec<Vec<String>> = analysis
        .parity
        .iter()
        .map(|mismatch| {
            vec![
                mismatch.scenario.clone(),
                mismatch.field.to_owned(),
                group(mismatch.js),
                group(mismatch.rust),
            ]
        })
        .collect();
    table(
        out,
        "  ",
        &[
            ("scenario", Align::Left),
            ("field", Align::Left),
            ("js", Align::Right),
            ("rust", Align::Right),
        ],
        &rows,
    )
}

fn network_section(
    out: &mut impl Write,
    analysis: &Analysis,
    network: &NetworkResult,
) -> io::Result<()> {
    let mut line = network_line(&network.profile, Scope::of(&network.caps));
    if let ClientCheck::BelowMinimum { .. } = network.client {
        line.push_str(", ");
        line.push_str(CLIENT_BELOW_MINIMUM);
    }
    writeln!(out, "{line}")?;
    // Nodes and size as the limits read them, both terms included.
    let rows: Vec<Vec<String>> = analysis
        .manifest
        .scenarios
        .iter()
        .zip(&analysis.measurements)
        .zip(network.evaluations.iter().zip(&network.capacities))
        .map(|((scenario, measurement), (evaluation, capacity))| {
            let (binding, ratio) = binding_cell(evaluation.binding());
            vec![
                scenario.name.clone(),
                or_dash(scenario.n),
                group(u64::from(scenario.calls)),
                group(u64::from(scenario.ops())),
                group(measurement.intents),
                group(evaluation.effective.nodes),
                or_dash(evaluation.proof.added()),
                or_dash(evaluation.balancing),
                group(evaluation.effective.estimated_size),
                binding,
                ratio,
                yes_no(evaluation.fits()).to_owned(),
                or_dash(capacity.txs),
                capacity
                    .binding
                    .map_or_else(|| "-".to_owned(), |binding| binding.name().to_owned()),
                or_dash(capacity.ops),
            ]
        })
        .collect();
    table(
        out,
        "",
        &[
            ("scenario", Align::Left),
            ("n", Align::Right),
            ("calls", Align::Right),
            ("ops", Align::Right),
            ("intents", Align::Right),
            ("nodes", Align::Right),
            ("proof", Align::Right),
            ("balancing", Align::Right),
            ("est size", Align::Right),
            ("binding", Align::Left),
            ("used", Align::Right),
            ("fits", Align::Left),
            ("txs/block", Align::Right),
            ("block bound", Align::Left),
            ("ops/block", Align::Right),
        ],
        &rows,
    )?;
    for (series, capacity) in analysis.series.iter().zip(&network.series) {
        writeln!(out)?;
        writeln!(
            out,
            "series {}: max n {}",
            series.name,
            series_verdict(capacity)
        )?;
        let rows: Vec<Vec<String>> = capacity
            .predictions
            .iter()
            .map(|(limit, prediction)| vec![limit.name().to_owned(), largest_cell(*prediction)])
            .collect();
        if capacity
            .predictions
            .iter()
            .any(|(_, prediction)| prediction.is_some())
        {
            table(
                out,
                "  ",
                &[("limit", Align::Left), ("fit max n", Align::Right)],
                &rows,
            )?;
        }
    }
    Ok(())
}

fn series_verdict(capacity: &SeriesCapacity) -> String {
    match (capacity.basis, capacity.boundary) {
        (Basis::Measured, Some(boundary)) => format!(
            "{}, measured ({} fits, {} over {})",
            group(boundary.largest_fit),
            group(boundary.largest_fit),
            group(boundary.smallest_over),
            boundary.binding.map_or("-", Limit::name),
        ),
        (Basis::Fit, _) => match capacity.max_n {
            Some(Largest::Max(n)) => format!(
                "{}, fit only (binds on {})",
                group(n),
                capacity.binding.map_or("-", Limit::name)
            ),
            _ => "unbounded, fit only".to_owned(),
        },
        _ => "n/a (one size)".to_owned(),
    }
}

/// A `u64` written as a decimal string.
#[derive(Clone, Copy, Debug)]
struct Decimal(u64);

impl Serialize for Decimal {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LimitJson {
    name: Limit,
    used: Option<Decimal>,
    allowed: Option<Decimal>,
    ratio_ppm: Option<u64>,
    status: Status,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimeToDismissJson {
    used: Decimal,
    allowed: Decimal,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProofTermJson {
    /// `added`, `proven` or `unknown`.
    status: &'static str,
    call_proofs: u64,
    builtin_proofs: u64,
    /// The bytes added; `null` unless `status` is `added`.
    bytes: Option<Decimal>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BalancingTermJson {
    intents: u64,
    /// The bytes added; `null` unless `scope` is `balanced`.
    bytes: Option<Decimal>,
}

/// One transaction under one profile; the shape `cost` prints and `check` nests.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EvaluationJson {
    serialized_len: u64,
    estimated_size: u64,
    declared_nodes: u32,
    cost: Cost,
    proof_term: ProofTermJson,
    balancing_term: BalancingTermJson,
    time_to_dismiss: TimeToDismissJson,
    /// What the transaction adds to the block total, the base extrinsic weight included.
    weight: Option<Decimal>,
    limits: Vec<LimitJson>,
    fits: bool,
    binding: Option<Limit>,
}

impl EvaluationJson {
    fn of(measurement: &Measurement, evaluation: &Evaluation) -> EvaluationJson {
        EvaluationJson {
            serialized_len: measurement.serialized_len,
            estimated_size: measurement.estimated_size(),
            declared_nodes: measurement.declared_nodes,
            cost: measurement.cost,
            proof_term: ProofTermJson {
                status: evaluation.proof.name(),
                call_proofs: measurement.proofs.calls,
                builtin_proofs: measurement.proofs.builtin,
                bytes: evaluation.proof.added().map(Decimal),
            },
            balancing_term: BalancingTermJson {
                intents: measurement.intents,
                bytes: evaluation.balancing.map(Decimal),
            },
            time_to_dismiss: TimeToDismissJson {
                used: Decimal(evaluation.effective.time_to_dismiss),
                allowed: Decimal(evaluation.time_to_dismiss_allowed),
            },
            weight: evaluation.weight.map(Decimal),
            limits: evaluation
                .checks
                .iter()
                .map(|check| LimitJson {
                    name: check.limit,
                    used: check.used.map(Decimal),
                    allowed: check.allowed.map(Decimal),
                    ratio_ppm: check.ratio().map(Ratio::ppm),
                    status: check.status(),
                })
                .collect(),
            fits: evaluation.fits(),
            binding: evaluation.binding().map(|check| check.limit),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkJson<'a> {
    network: &'a str,
    provisional: bool,
    node_release: Option<&'a str>,
    ledger_crate: &'a str,
    scope: Scope,
    params_identity: &'a str,
}

impl<'a> NetworkJson<'a> {
    fn of(profile: &'a Profile, scope: Scope) -> NetworkJson<'a> {
        NetworkJson {
            network: &profile.name,
            provisional: profile.provisional,
            node_release: profile.node_release.as_deref(),
            ledger_crate: &profile.ledger_crate,
            scope,
            params_identity: profile.identity.as_str(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CostJson<'a> {
    #[serde(flatten)]
    network: NetworkJson<'a>,
    form: Form,
    #[serde(flatten)]
    evaluation: EvaluationJson,
}

/// The `cost` JSON.
///
/// # Errors
///
/// Writing to `out` fails.
pub fn cost_json(
    out: &mut impl Write,
    profile: &Profile,
    form: Form,
    measurement: &Measurement,
    evaluation: &Evaluation,
) -> io::Result<()> {
    write_json(
        out,
        &CostJson {
            network: NetworkJson::of(profile, evaluation.scope),
            form,
            evaluation: EvaluationJson::of(measurement, evaluation),
        },
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParityJson<'a> {
    scenario: &'a str,
    field: &'a str,
    js: Decimal,
    rust: Decimal,
}

impl<'a> ParityJson<'a> {
    fn of(mismatch: &'a ParityMismatch) -> ParityJson<'a> {
        ParityJson {
            scenario: &mismatch.scenario,
            field: mismatch.field,
            js: Decimal(mismatch.js),
            rust: Decimal(mismatch.rust),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundJson {
    limit: Limit,
    /// A count, `unbounded`, or `n/a`.
    txs: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BlockJson {
    bounds: Vec<BoundJson>,
    txs_per_block: Option<u64>,
    binding: Option<&'static str>,
    ops_per_block: Option<u64>,
}

impl BlockJson {
    fn of(capacity: &Capacity) -> BlockJson {
        BlockJson {
            bounds: capacity
                .bounds
                .iter()
                .map(|bound| BoundJson {
                    limit: bound.limit,
                    txs: match bound.count {
                        Count::Txs(txs) => Value::from(txs),
                        Count::Unbounded => Value::from("unbounded"),
                        Count::NotApplicable => Value::from("n/a"),
                    },
                })
                .collect(),
            txs_per_block: capacity.txs,
            binding: capacity.binding.map(Binding::name),
            ops_per_block: capacity.ops,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioJson<'a> {
    name: &'a str,
    series: Option<&'a str>,
    n: Option<u64>,
    calls: u32,
    ops: u32,
    conflict: Conflict,
    #[serde(flatten)]
    evaluation: EvaluationJson,
    block: BlockJson,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PredictionJson {
    limit: Limit,
    /// A size, `unbounded`, or `n/a`.
    max_n: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BoundaryJson {
    largest_fit: u64,
    smallest_over: u64,
    binding: Option<Limit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeriesCapacityJson<'a> {
    name: &'a str,
    max_n: Option<u64>,
    basis: Basis,
    binding: Option<Limit>,
    boundary: Option<BoundaryJson>,
    predictions: Vec<PredictionJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkResultJson<'a> {
    #[serde(flatten)]
    network: NetworkJson<'a>,
    min_client_ledger: Option<String>,
    /// The manifest's client ledger is older than `minClientLedger`; a label, not a failure.
    client_below_minimum: bool,
    scenarios: Vec<ScenarioJson<'a>>,
    series: Vec<SeriesCapacityJson<'a>>,
}

/// Rounded to three decimals, so the JSON prints short digits; `-0.0` prints as `0.0`.
fn rounded(value: f64) -> f64 {
    let rounded = (value * 1000.0).round() / 1000.0;
    if rounded == 0.0 { 0.0 } else { rounded }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LineJson {
    metric: &'static str,
    fixed: f64,
    per_item: f64,
    max_residual: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SeriesFitJson<'a> {
    name: &'a str,
    sizes: &'a [u64],
    lines: Vec<LineJson>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DriftJson<'a> {
    path: &'a str,
    change: &'static str,
    snapshot: Option<&'a Value>,
    current: Option<&'a Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckJson<'a> {
    contract: &'a str,
    params_identity: &'a str,
    toolchain: &'a BTreeMap<String, String>,
    parity: Vec<ParityJson<'a>>,
    series: Vec<SeriesFitJson<'a>>,
    networks: Vec<NetworkResultJson<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    drift: Option<Vec<DriftJson<'a>>>,
}

/// The `check` and `update` JSON. `drift` is `None` for `update`.
///
/// # Errors
///
/// Writing to `out` fails.
pub fn check_json(
    out: &mut impl Write,
    analysis: &Analysis,
    drift: Option<&[Drift]>,
) -> io::Result<()> {
    let manifest = &analysis.manifest;
    let networks = analysis
        .networks
        .iter()
        .map(|network| NetworkResultJson {
            network: NetworkJson::of(&network.profile, Scope::of(&network.caps)),
            min_client_ledger: min_client_ledger(&network.profile),
            client_below_minimum: matches!(network.client, ClientCheck::BelowMinimum { .. }),
            scenarios: manifest
                .scenarios
                .iter()
                .zip(&analysis.measurements)
                .zip(network.evaluations.iter().zip(&network.capacities))
                .map(
                    |((scenario, measurement), (evaluation, capacity))| ScenarioJson {
                        name: &scenario.name,
                        series: scenario.series.as_deref(),
                        n: scenario.n,
                        calls: scenario.calls,
                        ops: scenario.ops(),
                        conflict: scenario.conflict,
                        evaluation: EvaluationJson::of(measurement, evaluation),
                        block: BlockJson::of(capacity),
                    },
                )
                .collect(),
            series: analysis
                .series
                .iter()
                .zip(&network.series)
                .map(|(series, capacity)| SeriesCapacityJson::of(&series.name, capacity))
                .collect(),
        })
        .collect();
    let report = CheckJson {
        contract: &manifest.contract,
        params_identity: &manifest.params_identity,
        toolchain: &manifest.toolchain,
        parity: analysis.parity.iter().map(ParityJson::of).collect(),
        series: analysis
            .series
            .iter()
            .map(|series| SeriesFitJson {
                name: &series.name,
                sizes: &series.fit.sizes,
                lines: series
                    .fit
                    .lines
                    .iter()
                    .map(|(metric, line)| LineJson {
                        metric: metric.name(),
                        fixed: rounded(line.fixed),
                        per_item: rounded(line.per_item),
                        max_residual: rounded(line.max_residual),
                    })
                    .collect(),
            })
            .collect(),
        networks,
        drift: drift.map(|drift| drift.iter().map(DriftJson::of).collect()),
    };
    write_json(out, &report)
}

impl<'a> SeriesCapacityJson<'a> {
    fn of(name: &'a str, capacity: &SeriesCapacity) -> SeriesCapacityJson<'a> {
        SeriesCapacityJson {
            name,
            max_n: capacity.max_n.and_then(Largest::value),
            basis: capacity.basis,
            binding: capacity.binding,
            boundary: capacity.boundary.map(|boundary| BoundaryJson {
                largest_fit: boundary.largest_fit,
                smallest_over: boundary.smallest_over,
                binding: boundary.binding,
            }),
            predictions: capacity
                .predictions
                .iter()
                .map(|(limit, prediction)| PredictionJson {
                    limit: *limit,
                    max_n: match prediction {
                        Some(Largest::Max(n)) => Value::from(*n),
                        Some(Largest::Unbounded) => Value::from("unbounded"),
                        None => Value::from("n/a"),
                    },
                })
                .collect(),
        }
    }
}

impl<'a> DriftJson<'a> {
    fn of(entry: &'a Drift) -> DriftJson<'a> {
        let (change, snapshot, current) = match &entry.change {
            Change::Changed { snapshot, current } => ("changed", Some(snapshot), Some(current)),
            Change::Added => ("added", None, None),
            Change::Removed => ("removed", None, None),
        };
        DriftJson {
            path: &entry.path,
            change,
            snapshot,
            current,
        }
    }
}

fn write_json(out: &mut impl Write, value: &impl Serialize) -> io::Result<()> {
    serde_json::to_writer_pretty(&mut *out, value)?;
    writeln!(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn group_inserts_thousands_separators() {
        assert_eq!(group(0), "0");
        assert_eq!(group(999), "999");
        assert_eq!(group(1_000), "1,000");
        assert_eq!(group(2_000_000_000_000), "2,000,000,000,000");
    }

    #[test]
    fn group_decimal_keeps_two_places_and_the_sign() {
        assert_eq!(group_decimal(1_234.5), "1,234.50");
        assert_eq!(group_decimal(-147.004), "-147.00");
        assert_eq!(group_decimal(-0.001), "0.00");
        assert_eq!(group_decimal(0.0), "0.00");
    }

    #[test]
    fn percent_truncates_to_two_places() {
        assert_eq!(percent(383_523), "38.35%");
        assert_eq!(percent(1_000_000), "100.00%");
        assert_eq!(percent(1_160_157), "116.01%");
        assert_eq!(percent(u64::MAX), "inf");
    }
}
