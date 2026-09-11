import {
  ContractOperation as RuntimeContractOperation,
  ContractState as RuntimeContractState,
} from '@midnight-ntwrk/compact-runtime';
import {
  ContractDeploy,
  ContractMaintenanceAuthority,
  ContractState as LedgerContractState,
  signatureVerifyingKey,
} from '@midnight-ntwrk/ledger-v8';
import { describe, expect, it } from 'vitest';
import { DeployError } from '../errors.ts';
import {
  operationNames,
  pruneState,
  toLedgerContractState,
} from './contract-state.ts';

const CIRCUITS = ['charge', 'burn', 'approve', 'evict', 'deposit'];

/** Constructor-shaped state: one operation per provable circuit. */
function constructorState(
  circuits: readonly string[] = CIRCUITS,
): RuntimeContractState {
  const state = new RuntimeContractState();
  for (const name of circuits) {
    state.setOperation(name, new RuntimeContractOperation());
  }
  return state;
}

describe('operationNames', () => {
  it('decodes a byte-encoded entry point name', () => {
    const stub = {
      operations: () => [new TextEncoder().encode('approve')],
    } as unknown as LedgerContractState;

    expect(operationNames(stub)).toStrictEqual(['approve']);
  });
});

describe('toLedgerContractState', () => {
  // INV-5
  it('produces a ledger state, not the runtime one', () => {
    const converted = toLedgerContractState(constructorState());

    expect(converted).toBeInstanceOf(LedgerContractState);
    expect(converted).not.toBeInstanceOf(RuntimeContractState);
  });
});

describe('pruneState', () => {
  // INV-7
  it('keeps only the named operations', () => {
    const pruned = pruneState({
      state: constructorState(),
      keep: ['approve', 'burn'],
    });

    expect(operationNames(pruned).sort()).toStrictEqual(['approve', 'burn']);
  });

  // INV-7
  it('carries data, maintenance authority and balance across unchanged', () => {
    const state = constructorState();
    const full = toLedgerContractState(state);
    const pruned = pruneState({ state, keep: ['approve'] });

    expect(pruned.data.toString(true)).toBe(full.data.toString(true));
    expect(pruned.maintenanceAuthority.committee).toStrictEqual(
      full.maintenanceAuthority.committee,
    );
    expect(pruned.maintenanceAuthority.threshold).toBe(
      full.maintenanceAuthority.threshold,
    );
    expect(pruned.maintenanceAuthority.counter).toBe(
      full.maintenanceAuthority.counter,
    );
    expect(pruned.balance).toStrictEqual(full.balance);
  });

  // INV-7
  it('keeps a non-default maintenance authority', () => {
    const state = constructorState();
    const committee = [signatureVerifyingKey('aa'.repeat(32))];
    const full = toLedgerContractState(state);
    full.maintenanceAuthority = new ContractMaintenanceAuthority(
      committee,
      1,
      0n,
    );
    const reserialized = LedgerContractState.deserialize(full.serialize());
    const pruned = pruneState({
      state: RuntimeContractState.deserialize(reserialized.serialize()),
      keep: ['approve'],
    });

    expect(pruned.maintenanceAuthority.committee).toStrictEqual(committee);
  });

  // INV-7
  it('yields the address the same pruned state deploys to', () => {
    const state = constructorState();
    const manual = toLedgerContractState(state);
    const fresh = new LedgerContractState();
    fresh.data = manual.data;
    fresh.maintenanceAuthority = manual.maintenanceAuthority;
    fresh.balance = manual.balance;
    const op = manual.operation('approve');
    if (op === undefined) throw new Error('fixture lost its operation');
    fresh.setOperation('approve', op);

    const pruned = pruneState({ state, keep: ['approve'] });

    expect(pruned.serialize()).toStrictEqual(fresh.serialize());
    // Deploy addresses are randomized, so the state bytes are what must match.
    expect(new ContractDeploy(pruned).initialState.serialize()).toStrictEqual(
      new ContractDeploy(fresh).initialState.serialize(),
    );
  });

  // INV-7
  it('rejects a fragment naming a circuit the constructor never produced', () => {
    expect(() =>
      pruneState({ state: constructorState(), keep: ['approve', 'nope'] }),
    ).toThrow(DeployError);
  });

  // INV-7
  it('rejects a duplicated circuit in the kept list', () => {
    expect(() =>
      pruneState({ state: constructorState(), keep: ['approve', 'approve'] }),
    ).toThrow(/Pruned state holds 1 operations, expected 2/);
  });

  // INV-7
  it('names the empty operation set when the constructor produced none', () => {
    expect(() =>
      pruneState({ state: new RuntimeContractState(), keep: ['approve'] }),
    ).toThrow('it carries (none)');
  });

  it('prunes to nothing when the kept list is empty', () => {
    expect(
      operationNames(pruneState({ state: constructorState(), keep: [] })),
    ).toStrictEqual([]);
  });
});
