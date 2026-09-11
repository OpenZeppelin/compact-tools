/**
 * Chain-side reads for the fragmented deploy: what is on chain, whether it is
 * ours, and whether it matches the artifact byte for byte.
 *
 * The deployments file is reporting only. Every decision the fragment loop
 * makes about which circuits to insert comes from here.
 */

import { verifierKeysEqual } from '@midnight-ntwrk/midnight-js-contracts';
import type { PublicDataProvider } from '@midnight-ntwrk/midnight-js-types';
import { ConfigError, FragmentDeployError } from '../errors.ts';
import type { ArtifactKeys } from '../loaders/artifact.ts';
import { operationNames } from './contract-state.ts';
import { remaining, sortCircuits } from './deploy-plan.ts';

/** Default gap between chain re-reads while waiting for the indexer to catch up. */
const DEFAULT_STATE_POLL_MS = 2_000;

/** One chain read of a contract's operations and maintenance authority. */
export interface ChainSnapshot {
  readonly circuits: readonly string[];
  readonly verifierKeys: ReadonlyMap<string, Uint8Array>;
  readonly counter: bigint;
  readonly committee: readonly string[];
  readonly threshold: number;
}

/** Snapshot of `address`, or `undefined` when no contract exists there. */
export async function readSnapshot(
  publicDataProvider: PublicDataProvider,
  address: string,
): Promise<ChainSnapshot | undefined> {
  const state = await publicDataProvider.queryContractState(address);
  if (state === null) return undefined;
  const circuits = sortCircuits(operationNames(state));
  const verifierKeys = new Map<string, Uint8Array>();
  for (const name of circuits) {
    const op = state.operation(name);
    if (op !== undefined) verifierKeys.set(name, op.verifierKey);
  }
  const authority = state.maintenanceAuthority;
  return {
    circuits,
    verifierKeys,
    counter: authority.counter,
    committee: [...authority.committee],
    threshold: authority.threshold,
  };
}

export interface AwaitCircuitsArgs {
  publicDataProvider: PublicDataProvider;
  address: string;
  /** Circuits the just-finalized fragment inserted. */
  expected: readonly string[];
  timeoutMs: number;
  pollMs?: number;
}

/**
 * INV-13: poll until every circuit of the landed fragment is visible, then
 * return that snapshot.
 *
 * The indexer trails the node, so the read taken right after finalization can
 * still be the pre-fragment state. Computing the next fragment from it would
 * re-insert keys that are already on chain and abort a healthy deploy.
 */
export async function awaitCircuitsOnChain({
  publicDataProvider,
  address,
  expected,
  timeoutMs,
  pollMs = DEFAULT_STATE_POLL_MS,
}: AwaitCircuitsArgs): Promise<ChainSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: ChainSnapshot | undefined;
  for (;;) {
    last = await readSnapshot(publicDataProvider, address);
    if (last !== undefined && remaining(expected, last.circuits).length === 0) {
      return last;
    }
    if (Date.now() >= deadline) {
      const missing = last ? remaining(expected, last.circuits) : [...expected];
      throw new FragmentDeployError({
        address,
        circuitsOnChain: last?.circuits ?? [],
        circuitsPending: missing,
        reason: `chain state still missing ${missing.join(', ')} after ${timeoutMs} ms`,
      });
    }
    await delay(pollMs);
  }
}

export interface VerifyStateArgs {
  address: string;
  artifactKeys: ArtifactKeys;
  snapshot: ChainSnapshot;
  /** The authority read before the first insert. INV-15: it must not move. */
  authority: Pick<ChainSnapshot, 'committee' | 'threshold'>;
}

/**
 * INV-11: every artifact circuit present on chain with identical key bytes,
 * and no extra on-chain circuit. A count check would pass a state that has the
 * right number of operations under the wrong names.
 */
export function verifyState({
  address,
  artifactKeys,
  snapshot,
  authority,
}: VerifyStateArgs): void {
  // INV-15: inserts are additive and never touch the authority, so a committee
  // or threshold that moved means someone else maintained this contract
  // mid-run.
  if (
    snapshot.threshold !== authority.threshold ||
    snapshot.committee.length !== authority.committee.length ||
    snapshot.committee.some((key, i) => key !== authority.committee[i])
  ) {
    throw new ConfigError(
      `Maintenance authority of ${address} changed during the deploy: committee [${authority.committee.join(', ')}] threshold ${authority.threshold} became committee [${snapshot.committee.join(', ')}] threshold ${snapshot.threshold}.`,
    );
  }
  const problems = compare(artifactKeys, snapshot);
  if (problems.length === 0) return;
  throw new FragmentDeployError({
    address,
    circuitsOnChain: snapshot.circuits,
    circuitsPending: remaining([...artifactKeys.keys()], snapshot.circuits),
    reason: `on-chain state does not match the artifact: ${problems.join('; ')}`,
  });
}

/**
 * INV-25: this signing key's slot in the on-chain committee.
 *
 * Rejects a committee this deployer cannot satisfy alone: it holds one key, so
 * a threshold above 1 makes every update unsignable here.
 */
export function signerIndex({
  address,
  snapshot,
  verifyingKey,
}: {
  address: string;
  snapshot: ChainSnapshot;
  /** Public half of the loaded signing key. Never the signing key. */
  verifyingKey: string;
}): number {
  if (snapshot.threshold !== 1) {
    throw new ConfigError(
      `Contract ${address} needs ${snapshot.threshold} maintenance signatures; the deployer holds one key. Complete this deploy with a multi-signer tool.`,
    );
  }
  const index = snapshot.committee.indexOf(verifyingKey);
  if (index < 0) {
    throw new ConfigError(
      `Contract ${address} is not maintained by this signing key. Check signing_key_file, or re-run with --force to deploy fresh.`,
    );
  }
  return index;
}

export interface AssertResumableArgs {
  address: string;
  artifactKeys: ArtifactKeys;
  snapshot: ChainSnapshot | undefined;
  /** Verifying key derived from the loaded signing key. Never the signing key. */
  verifyingKey: string;
}

/**
 * INV-27: gate a resume on the recorded address really being our partially
 * deployed contract. An edited or copied deployments file must not make the deployer
 * append this artifact's keys to someone else's contract, or to a stale build
 * of our own.
 */
export function assertResumable({
  address,
  artifactKeys,
  snapshot,
  verifyingKey,
}: AssertResumableArgs): ChainSnapshot {
  if (snapshot === undefined) {
    throw new ConfigError(
      `Deployments ledger has a partial deploy at ${address} but no contract exists there. Re-run with --force to deploy fresh.`,
    );
  }
  signerIndex({ address, snapshot, verifyingKey });
  const mismatches = compare(artifactKeys, snapshot, { partial: true });
  if (mismatches.length > 0) {
    throw new ConfigError(
      `Contract ${address} carries verifier keys from a different build: ${mismatches.join('; ')}. Re-run with --force to deploy fresh.`,
    );
  }
  return snapshot;
}

/**
 * Key-by-key comparison. With `partial`, artifact circuits not yet on chain
 * are expected; without it, a missing circuit is a failure.
 */
function compare(
  artifactKeys: ArtifactKeys,
  snapshot: ChainSnapshot,
  opts: { partial?: boolean } = {},
): string[] {
  const problems: string[] = [];
  for (const name of snapshot.circuits) {
    const expected = artifactKeys.get(name);
    if (expected === undefined) {
      // INV-27(c): renaming a circuit between runs needs --force, not a
      // silent append onto a state the artifact can no longer describe.
      problems.push(`"${name}" is on chain but not in the artifact`);
      continue;
    }
    const actual = snapshot.verifierKeys.get(name);
    if (actual === undefined || !verifierKeysEqual(expected, actual)) {
      problems.push(`"${name}" has a different verifier key on chain`);
    }
  }
  if (opts.partial !== true) {
    for (const name of remaining([...artifactKeys.keys()], snapshot.circuits)) {
      problems.push(`"${name}" is missing on chain`);
    }
  }
  return problems;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
