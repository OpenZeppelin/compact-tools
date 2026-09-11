/**
 * Bridges the constructor's compact-runtime `ContractState` to the ledger-v8
 * one and prunes it down to a single fragment's operations.
 *
 * The two `ContractState` classes are unrelated WASM types with the same name.
 * Everything that reaches `ContractDeploy` or `MaintenanceUpdate` must be the
 * ledger one, so the conversion has exactly one home.
 */

import type { ContractState as RuntimeContractState } from '@midnight-ntwrk/compact-runtime';
import { ContractState as LedgerContractState } from '@midnight-ntwrk/ledger-v8';
import { DeployError } from '../errors.ts';

/** INV-5: serialize-round-trip a runtime state into its ledger counterpart. */
export function toLedgerContractState(
  state: RuntimeContractState,
): LedgerContractState {
  return LedgerContractState.deserialize(state.serialize());
}

/** Operation names on a ledger state, as strings. */
export function operationNames(state: LedgerContractState): string[] {
  return state.operations().map(asOperationName);
}

export interface PruneStateArgs {
  /** Constructor output, holding one operation per provable circuit. */
  state: RuntimeContractState;
  /** Fragment 0's circuits. Every name must exist on `state`. */
  keep: readonly string[];
}

/**
 * Ledger state carrying `data`, `maintenanceAuthority` and `balance` unchanged
 * and only `keep`'s operations.
 *
 * `ContractState` has no operation-removal method, so the pruned state is
 * built fresh and the kept operations copied across. `new ContractDeploy(...)`
 * on the result fixes the contract address; later fragments do not move it.
 */
export function pruneState({
  state,
  keep,
}: PruneStateArgs): LedgerContractState {
  const full = toLedgerContractState(state);
  const available = new Set(operationNames(full));
  const pruned = new LedgerContractState();
  pruned.data = full.data;
  pruned.maintenanceAuthority = full.maintenanceAuthority;
  pruned.balance = full.balance;

  for (const name of keep) {
    const op = full.operation(name);
    if (op === undefined) {
      // INV-7: a fragment naming a circuit the constructor never produced
      // would deploy a state the artifact cannot describe.
      throw new DeployError(
        `Constructor state has no operation "${name}"; it carries ${[...available].sort().join(', ') || '(none)'}.`,
      );
    }
    pruned.setOperation(name, op);
  }

  // INV-7: pruning must lose the later fragments and nothing else.
  const kept = operationNames(pruned);
  if (kept.length !== keep.length) {
    throw new DeployError(
      `Pruned state holds ${kept.length} operations, expected ${keep.length}.`,
    );
  }
  return pruned;
}

/** Operation keys come back as `string | Uint8Array`; circuit ids are the string arm. */
function asOperationName(key: string | Uint8Array): string {
  return typeof key === 'string' ? key : Buffer.from(key).toString('utf8');
}
