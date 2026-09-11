import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ReplaceAuthority,
  signatureVerifyingKey,
  VerifierKeyInsert,
  VerifierKeyRemove,
  verifySignature,
} from '@midnight-ntwrk/ledger-v8';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { beforeAll, describe, expect, it } from 'vitest';
import { DeployError } from '../errors.ts';
import {
  buildInsertTx,
  buildInsertUpdate,
  verifyingKeyOf,
} from './maintenance-tx.ts';

/**
 * A real compiler-emitted key: the ledger checks the `midnight:verifier-key`
 * header on construction, so arbitrary bytes cannot stand in.
 */
const VERIFIER_KEY = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL('./fixtures/counter-increment.verifier', import.meta.url),
    ),
  ),
);

// `buildInsertTx` reads the midnight-js network-id singleton, which the
// deployer sets from `[networks.X].network_id` before any tx is built.
beforeAll(() => {
  setNetworkId('undeployed');
});

const SIGNING_KEY = 'aa'.repeat(32);
const OTHER_KEY = 'bc'.repeat(32);
const ADDRESS = 'cd'.repeat(32);

function inserts(...circuitIds: string[]) {
  return circuitIds.map((circuitId) => ({
    circuitId,
    verifierKey: VERIFIER_KEY,
  }));
}

describe('verifyingKeyOf', () => {
  // INV-24
  it('returns the public half of the signing key', () => {
    const verifying = verifyingKeyOf(SIGNING_KEY);

    expect(verifying).toBe(signatureVerifyingKey(SIGNING_KEY));
    expect(verifying).not.toContain(SIGNING_KEY);
  });
});

describe('buildInsertUpdate', () => {
  // INV-4
  it('emits one VerifierKeyInsert per circuit and nothing else', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment', 'reset'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(update.updates).toHaveLength(2);
    for (const single of update.updates) {
      expect(single).toBeInstanceOf(VerifierKeyInsert);
      expect(single).not.toBeInstanceOf(VerifierKeyRemove);
      expect(single).not.toBeInstanceOf(ReplaceAuthority);
    }
    expect(
      update.updates.map((u) => (u as VerifierKeyInsert).operation),
    ).toStrictEqual(['increment', 'reset']);
  });

  // INV-14
  it('targets the address it was given', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(update.address).toBe(ADDRESS);
  });

  // INV-28
  it('uses the counter it was given verbatim', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 7n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(update.counter).toBe(7n);
  });

  // INV-25
  it('signs with committee member 0 and the signature verifies', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(update.signatures).toHaveLength(1);
    const [index, signature] = update.signatures[0] as [bigint, string];
    expect(index).toBe(0n);
    expect(
      verifySignature(
        signatureVerifyingKey(SIGNING_KEY),
        update.dataToSign,
        signature,
      ),
    ).toBe(true);
  });

  // INV-25
  it('produces a signature no other key validates', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });
    const [, signature] = update.signatures[0] as [bigint, string];

    expect(
      verifySignature(
        signatureVerifyingKey(OTHER_KEY),
        update.dataToSign,
        signature,
      ),
    ).toBe(false);
  });

  // INV-25
  it('produces a signature that does not carry to a different insert list', () => {
    const one = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });
    const two = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment', 'reset'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });
    const [, signature] = one.signatures[0] as [bigint, string];

    expect(two.dataToSign).not.toStrictEqual(one.dataToSign);
    expect(
      verifySignature(
        signatureVerifyingKey(SIGNING_KEY),
        two.dataToSign,
        signature,
      ),
    ).toBe(false);
  });

  // INV-22
  it('keeps the signing key out of the rendered update', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(update.toString(false)).not.toContain(SIGNING_KEY);
  });

  // INV-10
  it('refuses an empty insert list', () => {
    expect(() =>
      buildInsertUpdate({
        address: ADDRESS,
        inserts: [],
        counter: 0n,
        signingKey: SIGNING_KEY,
        signerIndex: 0,
      }),
    ).toThrow(DeployError);
  });
});

describe('buildInsertTx', () => {
  // INV-4
  it('wraps the update in an intent with no calls and no offers', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    const rendered = buildInsertTx({ update }).toString(false);

    expect(rendered).toContain('MaintenanceUpdate');
    expect(rendered).toContain('guaranteed_unshielded_offer: None');
    expect(rendered).toContain('fallible_unshielded_offer: None');
    expect(rendered).not.toContain('ContractCall');
  });

  // INV-22
  it('keeps the signing key out of the rendered tx', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(buildInsertTx({ update }).toString(false)).not.toContain(
      SIGNING_KEY,
    );
  });
});

describe('buildInsertUpdate committee slot', () => {
  // INV-25
  it('signs at the slot it was given, not slot 0', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 2,
    });

    const [index, signature] = update.signatures[0] as [bigint, string];
    expect(index).toBe(2n);
    expect(
      verifySignature(
        signatureVerifyingKey(SIGNING_KEY),
        update.dataToSign,
        signature,
      ),
    ).toBe(true);
  });
});
