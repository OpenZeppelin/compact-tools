//! `compact-profile` end to end, one fixture case per behaviour.
//!
//! Every case runs inside `tests/fixtures/<case>/` and shares the transactions, manifest
//! and snapshot in `tests/fixtures/token/`.

use std::path::PathBuf;
use std::process::Command;

use assert_cmd::prelude::*;

/// Exit code for parity mismatches or snapshot drift.
const EXIT_FINDINGS: i32 = 1;

/// Exit code for a usage, input, IO or ledger error.
const EXIT_ERROR: i32 = 2;

const MANIFEST: &str = "../token/manifest.json";

/// The fixture manifest's client ledger, 1.0.0-rc.5, is below mainnet's 1.0.2.
const CLIENT_WARNING: &str = "compact-profile: warning: the transactions were built with \
    @midnightntwrk/ledger-v9 1.0.0-rc.5, below mainnet's minimum client ledger 1.0.2; the \
    network may refuse what that client builds.\n";
const SNAPSHOT: &str = "../token/snapshot.json";

fn case(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(name)
}

fn expected(name: &str, file: &str) -> String {
    std::fs::read_to_string(case(name).join(file)).expect("the case has an expectation")
}

/// Runs the binary inside a case directory and returns its exit code, stdout and stderr.
fn run(name: &str, args: &[&str]) -> (i32, String, String) {
    let output = Command::cargo_bin("compact-profile")
        .expect("the binary is built alongside this test")
        .current_dir(case(name))
        .args(args)
        .output()
        .expect("the binary ran");
    (
        output.status.code().expect("the binary was not signalled"),
        String::from_utf8(output.stdout).expect("the report is UTF-8"),
        String::from_utf8(output.stderr).expect("the summary is UTF-8"),
    )
}

fn check(name: &str, manifest: &str, snapshot: &str, extra: &[&str]) -> (i32, String, String) {
    let mut args = vec![
        "check",
        "--manifest",
        manifest,
        "--network",
        "mainnet",
        "--snapshot",
        snapshot,
    ];
    args.extend_from_slice(extra);
    run(name, &args)
}

#[test]
fn check_passes_when_parity_holds_and_the_snapshot_matches() {
    let (code, stdout, stderr) = check("check-pass", MANIFEST, SNAPSHOT, &[]);
    assert_eq!(stdout, expected("check-pass", "expected.txt"));
    assert_eq!(code, 0);
    assert_eq!(
        stderr,
        format!("{CLIENT_WARNING}Checked 10 scenarios on 1 network. Snapshot matches.\n")
    );
}

#[test]
fn an_old_client_ledger_labels_the_network_without_failing() {
    let (code, stdout, _) = check("check-pass", MANIFEST, SNAPSHOT, &[]);
    assert_eq!(code, 0);
    assert!(
        stdout.contains("captured 2026-11-20, balanced, client below minimum\n"),
        "{stdout}"
    );
    let (_, json, _) = check("check-pass", MANIFEST, SNAPSHOT, &["--reporter", "json"]);
    let report: serde_json::Value = serde_json::from_str(&json).expect("check prints JSON");
    assert_eq!(report["networks"][0]["clientBelowMinimum"], true);
    assert_eq!(report["networks"][0]["minClientLedger"], "1.0.2");
}

/// `update --reporter json` into a temporary snapshot, parsed, with stderr.
fn update_json(name: &str, manifest: &str) -> (serde_json::Value, String) {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let snapshot = dir.path().join("snapshot.json");
    let (code, stdout, stderr) = run(
        name,
        &[
            "update",
            "--manifest",
            manifest,
            "--network",
            "mainnet",
            "--snapshot",
            snapshot.to_str().expect("the path is UTF-8"),
            "--reporter",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    (
        serde_json::from_str(&stdout).expect("update prints JSON"),
        stderr,
    )
}

#[test]
fn ops_default_to_calls_in_the_report() {
    let (report, _) = update_json("check-pass", MANIFEST);
    let merged = &report["networks"][0]["scenarios"][7];
    assert_eq!(merged["name"], "base-merged-n32");
    assert_eq!(merged["ops"], 32);
    assert_eq!(merged["block"]["txsPerBlock"], 2);
    assert_eq!(merged["block"]["opsPerBlock"], 64);
}

#[test]
fn a_batch_circuit_counts_its_ops_per_block() {
    let (report, _) = update_json("check-ops", "manifest.json");
    let batch = &report["networks"][0]["scenarios"][0];
    assert_eq!(batch["calls"], 1);
    assert_eq!(batch["ops"], 8);
    assert_eq!(batch["block"]["txsPerBlock"], 30);
    assert_eq!(batch["block"]["opsPerBlock"], 240);
}

#[test]
fn a_manifest_without_a_client_ledger_says_so_once_and_is_not_labelled() {
    let (report, stderr) = update_json("check-ops", "manifest-no-client.json");
    assert_eq!(report["networks"][0]["clientBelowMinimum"], false);
    assert_eq!(
        stderr
            .matches("has no @midnightntwrk/ledger-v9 version")
            .count(),
        1,
        "{stderr}"
    );
}

#[test]
fn params_prints_json_for_the_runner() {
    let (code, stdout, _) = run(
        "params-json",
        &["params", "--network", "mainnet", "--reporter", "json"],
    );
    assert_eq!(stdout, expected("params-json", "expected.txt"));
    assert_eq!(code, 0);
}

#[test]
fn check_prints_json_for_the_runner() {
    let (code, stdout, _) = check("check-json", MANIFEST, SNAPSHOT, &["--reporter", "json"]);
    assert_eq!(stdout, expected("check-json", "expected.txt"));
    assert_eq!(code, 0);
}

#[test]
fn check_evaluates_each_network_and_marks_unknown_caps_not_applicable() {
    let (code, stdout, _) = run(
        "check-networks",
        &[
            "check",
            "--manifest",
            MANIFEST,
            "--network",
            "mainnet",
            "--network",
            "undeployed",
            "--snapshot",
            "snapshot.json",
        ],
    );
    assert_eq!(stdout, expected("check-networks", "expected.txt"));
    assert_eq!(code, 0);
}

#[test]
fn check_fails_on_a_drifted_snapshot_and_names_each_value() {
    let (code, stdout, stderr) = check("check-drift", MANIFEST, "snapshot.json", &[]);
    assert_eq!(stdout, expected("check-drift", "expected.txt"));
    assert_eq!(code, EXIT_FINDINGS);
    assert_eq!(
        stderr,
        format!(
            "{CLIENT_WARNING}Checked 10 scenarios on 1 network. Found 9 drifted values. \
             1 scenario no longer fits.\n"
        )
    );
}

#[test]
fn check_refuses_a_manifest_built_with_other_parameters() {
    let (code, stdout, stderr) = check("check-identity", "manifest.json", SNAPSHOT, &[]);
    assert_eq!(stdout, "");
    assert_eq!(code, EXIT_ERROR);
    assert!(
        stderr.contains("does not match profile mainnet (ba96a2b0beca6f2e"),
        "{stderr}"
    );
}

#[test]
fn check_fails_when_the_runner_reported_other_numbers() {
    let (code, stdout, stderr) = check("check-parity", "manifest.json", SNAPSHOT, &[]);
    assert_eq!(stdout, expected("check-parity", "expected.txt"));
    assert_eq!(code, EXIT_FINDINGS);
    assert!(stderr.contains("Found 2 parity mismatches."), "{stderr}");
}

#[test]
fn size_tolerance_absorbs_byte_jitter_between_runs() {
    let rerun = "../token/manifest-rerun.json";
    let (code, stdout, _) = check("check-tolerance", rerun, SNAPSHOT, &[]);
    assert_eq!(stdout, expected("check-tolerance", "expected.txt"));
    assert_eq!(code, EXIT_FINDINGS);

    let (code, stdout, _) = check(
        "check-tolerance",
        rerun,
        SNAPSHOT,
        &["--size-tolerance", "2"],
    );
    assert!(stdout.ends_with("\nsnapshot matches\n"), "{stdout}");
    assert_eq!(code, 0);
}

#[test]
fn a_missing_snapshot_is_an_error() {
    let (code, stdout, stderr) = check("check-pass", MANIFEST, "absent.json", &[]);
    assert_eq!(stdout, "");
    assert_eq!(code, EXIT_ERROR);
    assert!(
        stderr.contains("`compact-profile update` writes it"),
        "{stderr}"
    );
}

#[test]
fn update_writes_the_committed_snapshot_and_check_accepts_it() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let written = dir.path().join("snapshot.json");
    let written_arg = written.to_str().expect("the path is UTF-8");
    let (code, _, stderr) = run(
        "check-pass",
        &[
            "update",
            "--manifest",
            MANIFEST,
            "--network",
            "mainnet",
            "--snapshot",
            written_arg,
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    let text = std::fs::read_to_string(&written).expect("update wrote the snapshot");
    assert_eq!(text, expected("token", "snapshot.json"));

    let (code, _, _) = check("check-pass", MANIFEST, written_arg, &[]);
    assert_eq!(code, 0);
}

#[test]
fn update_refuses_to_write_when_parity_fails() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let written = dir.path().join("snapshot.json");
    let (code, _, stderr) = run(
        "check-parity",
        &[
            "update",
            "--manifest",
            "manifest.json",
            "--network",
            "mainnet",
            "--snapshot",
            written.to_str().expect("the path is UTF-8"),
        ],
    );
    assert_eq!(code, EXIT_FINDINGS);
    assert!(stderr.ends_with("Snapshot not written.\n"), "{stderr}");
    assert!(!written.exists());
}

#[test]
fn cost_prints_one_transaction_as_json() {
    let (code, stdout, _) = run(
        "cost-json",
        &[
            "cost",
            "../token/txs/base-mint.bin",
            "--network",
            "mainnet",
            "--reporter",
            "json",
        ],
    );
    assert_eq!(stdout, expected("cost-json", "expected.txt"));
    assert_eq!(code, 0);
}

#[test]
fn cost_reports_a_transaction_over_the_node_cap_without_failing() {
    let (code, stdout, _) = run(
        "cost-table",
        &[
            "cost",
            "../token/txs/base-merged-n48.bin",
            "--network",
            "mainnet",
        ],
    );
    assert_eq!(stdout, expected("cost-table", "expected.txt"));
    assert_eq!(code, 0);
}

#[test]
fn cost_evaluates_a_balanced_transaction_as_submitted() {
    let (code, stdout, _) = run(
        "cost-balanced",
        &[
            "cost",
            "../live/base-mint-balanced.bin",
            "--network",
            "mainnet",
            "--reporter",
            "json",
        ],
    );
    assert_eq!(stdout, expected("cost-balanced", "expected.txt"));
    assert_eq!(code, 0);
}

/// `cost --reporter json` on a live-node fixture, parsed.
fn cost_json(file: &str) -> serde_json::Value {
    let (code, stdout, stderr) = run(
        "cost-balanced",
        &["cost", file, "--network", "mainnet", "--reporter", "json"],
    );
    assert_eq!(code, 0, "{stderr}");
    serde_json::from_str(&stdout).expect("cost prints JSON")
}

fn nodes_used(report: &serde_json::Value) -> &str {
    report["limits"][0]["used"]
        .as_str()
        .expect("nodes is the first limit")
}

#[test]
fn a_proven_transaction_gets_the_balancing_term() {
    let report = cost_json("../live/base-mint-proven.bin");
    assert_eq!(report["form"], "proven");
    assert_eq!(report["scope"], "balanced");
    assert_eq!(nodes_used(&report), "99");
}

#[test]
fn the_node_cap_splits_the_live_multi_call_transactions_as_the_node_did() {
    // Landed at 1,010 and 995 nodes; rejected at 1,034 and 1,025.
    let cases = [
        ("../live/base-merged-n40-unproven.bin", "1012", true),
        ("../live/base-merged-n41-unproven.bin", "1035", false),
        ("../live/preset-merged-n29-unproven.bin", "996", true),
        ("../live/preset-merged-n30-unproven.bin", "1027", false),
    ];
    for (file, nodes, fits) in cases {
        let report = cost_json(file);
        assert_eq!(nodes_used(&report), nodes, "{file}");
        assert_eq!(report["fits"], fits, "{file}");
        if !fits {
            assert_eq!(report["binding"], "nodes", "{file}");
        }
    }
}

#[test]
fn check_refuses_a_transaction_that_is_not_unproven() {
    let (code, stdout, stderr) = check("check-form", "manifest.json", SNAPSHOT, &[]);
    assert_eq!(stdout, "");
    assert_eq!(code, EXIT_ERROR);
    assert!(
        stderr
            .contains("is a proven transaction; check and update read unproven transactions only"),
        "{stderr}"
    );
}

#[test]
fn params_writes_the_captured_bytes_and_prints_the_identity() {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let out = dir.path().join("params.bin");
    let (code, stdout, _) = run(
        "params",
        &[
            "params",
            "--network",
            "mainnet",
            "--out",
            out.to_str().expect("the path is UTF-8"),
        ],
    );
    assert_eq!(stdout, expected("params", "expected.txt"));
    assert_eq!(code, 0);
    let written = std::fs::read(&out).expect("params wrote the bytes");
    let captured = std::fs::read(case("params").join("live-mainnet.bin")).expect("the capture");
    assert_eq!(written, captured);
}

#[test]
fn params_identity_is_shared_by_every_shipped_network() {
    for network in ["preprod", "undeployed"] {
        let (code, stdout, _) = run("params", &["params", "--network", network]);
        assert_eq!(stdout, expected("params", "expected.txt"), "{network}");
        assert_eq!(code, 0);
    }
}

#[test]
fn an_unknown_network_is_an_error() {
    let (code, stdout, stderr) = run("params", &["params", "--network", "devnet"]);
    assert_eq!(stdout, "");
    assert_eq!(code, EXIT_ERROR);
    assert!(
        stderr.contains("shipped: mainnet, preprod, undeployed"),
        "{stderr}"
    );
}
