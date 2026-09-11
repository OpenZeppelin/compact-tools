/**
 * Builds the batched verifier-key insert that carries one fragment.
 *
 * midnight-js's `submitInsertVerifierKeyTx` does one key per tx and re-reads
 * chain state for each, which costs a tx per circuit. This module assembles
 * many `VerifierKeyInsert`s into a single signed `MaintenanceUpdate`.
 */

import {
  ContractOperationVersionedVerifierKey,
  Intent,
  MaintenanceUpdate,
  signatureVerifyingKey,
  signData,
  Transaction,
  VerifierKeyInsert,
} from '@midnight-ntwrk/ledger-v8';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import { DeployError } from '../errors.ts';

/** Only ledger operation version the compiler emits keys for. */
const VK_VERSION = 'v3' as const;

/**
 * INV-4: one circuit's key. The absence of any other update shape is what
 * makes removal, replacement, and authority rotation unconstructible here.
 */
export interface KeyInsert {
  readonly circuitId: string;
  readonly verifierKey: Uint8Array;
}

export interface BuildInsertUpdateArgs {
  /** INV-14: taken from the fragment-0 result or the record, never recomputed. */
  address: string;
  inserts: readonly KeyInsert[];
  /** INV-28: read from chain immediately before this call; never tracked locally. */
  counter: bigint;
  /** INV-22: hex signing key. Reaches `signData` and nothing else. */
  signingKey: string;
  /**
   * INV-25: this key's slot in the on-chain committee, from the same chain read
   * as `counter`. The ledger checks the signature against that slot, so a
   * hardcoded 0 would fail on any contract whose committee is ordered
   * differently.
   */
  signerIndex: number;
}

/** Verifying key for a hex signing key. The public half is the only part that may be logged. */
export function verifyingKeyOf(signingKey: string): string {
  return signatureVerifyingKey(signingKey);
}

/**
 * Signed insert-only maintenance update for `address` at `counter`.
 *
 * The signature covers the address, the whole insert list, and the counter, so
 * a tampered or replayed update fails the ledger's check rather than ours.
 */
export function buildInsertUpdate({
  address,
  inserts,
  counter,
  signingKey,
  signerIndex,
}: BuildInsertUpdateArgs): MaintenanceUpdate {
  if (inserts.length === 0) {
    // INV-10: an empty update would spend dust and change nothing.
    throw new DeployError('Refusing to build an empty maintenance update.');
  }
  const updates = inserts.map(
    ({ circuitId, verifierKey }) =>
      new VerifierKeyInsert(
        circuitId,
        new ContractOperationVersionedVerifierKey(VK_VERSION, verifierKey),
      ),
  );
  // INV-25: sign the built update, then attach; `addSignature` returns the
  // signed value rather than mutating in place.
  const update = new MaintenanceUpdate(address, updates, counter);
  return update.addSignature(
    BigInt(signerIndex),
    signData(signingKey, update.dataToSign),
  );
}

export interface BuildInsertTxArgs {
  update: MaintenanceUpdate;
}

/**
 * Wrap a signed update in an unproven tx. No Zswap offer: a maintenance update
 * creates no coins, and the wallet adds the dust fee spend when it balances.
 */
export function buildInsertTx({
  update,
}: BuildInsertTxArgs): ReturnType<typeof Transaction.fromParts> {
  const intent = Intent.new(ttlOneHour()).addMaintenanceUpdate(update);
  return Transaction.fromParts(getNetworkId(), undefined, undefined, intent);
}
