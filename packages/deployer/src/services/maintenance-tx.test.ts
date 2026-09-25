import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  ReplaceAuthority,
  type Signature,
  type SigningKey,
  signatureVerifyingKey,
  VerifierKeyInsert,
  VerifierKeyRemove,
  verifySignature,
} from '@midnightntwrk/ledger-v9';
import { beforeAll, describe, expect, it } from 'vitest';
import { DeployError } from '../errors.ts';
import {
  buildInsertTx,
  buildInsertUpdate,
  verifyingKeyOf,
  versionedVerifierKey,
} from './maintenance-tx.ts';

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))),
  );

/**
 * Real compiler-emitted keys: the ledger checks the `midnight:verifier-key`
 * header on construction, so arbitrary bytes cannot stand in. The zkir-v3
 * build of the same circuit emits the next header version.
 */
const VERIFIER_KEY = fixture('counter-increment.verifier');
const ZKIR_V3_VERIFIER_KEY = fixture('counter-increment-zkir-v3.verifier');

// `buildInsertTx` reads the midnight-js network-id singleton, which the
// deployer sets from `[networks.X].network_id` before any tx is built.
beforeAll(() => {
  setNetworkId('undeployed');
});

const SIGNING_KEY_HEX = 'aa'.repeat(32);
const SIGNING_KEY: SigningKey = { tag: 'schnorr', value: SIGNING_KEY_HEX };
const OTHER_KEY: SigningKey = { tag: 'schnorr', value: 'bc'.repeat(32) };
const ADDRESS = 'cd'.repeat(32);

function inserts(...circuitIds: string[]) {
  return circuitIds.map((circuitId) => ({
    circuitId,
    verifierKey: VERIFIER_KEY,
  }));
}

describe('verifyingKeyOf', () => {
  it('should return the public half of the signing key', () => {
    const verifying = verifyingKeyOf(SIGNING_KEY);

    expect(verifying).toStrictEqual(signatureVerifyingKey(SIGNING_KEY));
    expect(verifying.value).not.toBe(SIGNING_KEY.value);
  });
});

describe('versionedVerifierKey', () => {
  it('should version a `[v6]` key as v3', () => {
    expect(versionedVerifierKey('increment', VERIFIER_KEY).version).toBe('v3');
  });

  it('should version a zkir-v3 `[v7]` key as v4', () => {
    expect(
      versionedVerifierKey('increment', ZKIR_V3_VERIFIER_KEY).version,
    ).toBe('v4');
  });

  it('should reject a key no ledger version accepts, naming the circuit', () => {
    expect(() =>
      versionedVerifierKey('increment', new Uint8Array([1, 2, 3])),
    ).toThrow(/Verifier key for circuit "increment" matches no ledger version/);
    expect(() =>
      versionedVerifierKey('increment', new Uint8Array([1, 2, 3])),
    ).toThrow(DeployError);
  });
});

describe('buildInsertUpdate', () => {
  it('should insert keys of different versions in one update', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: [
        { circuitId: 'increment', verifierKey: VERIFIER_KEY },
        { circuitId: 'reset', verifierKey: ZKIR_V3_VERIFIER_KEY },
      ],
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(
      update.updates.map((u) => (u as VerifierKeyInsert).vk.version),
    ).toStrictEqual(['v3', 'v4']);
  });

  it('should emit one VerifierKeyInsert per circuit and nothing else', () => {
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

  it('should target the address it was given', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(update.address).toBe(ADDRESS);
  });

  it('should use the counter it was given verbatim', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 7n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(update.counter).toBe(7n);
  });

  it('should sign with committee member 0 and the signature verifies', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(update.signatures).toHaveLength(1);
    const [index, signature] = update.signatures[0] as [bigint, Signature];
    expect(index).toBe(0n);
    expect(
      verifySignature(
        signatureVerifyingKey(SIGNING_KEY),
        update.dataToSign,
        signature,
      ),
    ).toBe(true);
  });

  it('should produce a signature no other key validates', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });
    const [, signature] = update.signatures[0] as [bigint, Signature];

    expect(
      verifySignature(
        signatureVerifyingKey(OTHER_KEY),
        update.dataToSign,
        signature,
      ),
    ).toBe(false);
  });

  it('should produce a signature that does not carry to a different insert list', () => {
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
    const [, signature] = one.signatures[0] as [bigint, Signature];

    expect(two.dataToSign).not.toStrictEqual(one.dataToSign);
    expect(
      verifySignature(
        signatureVerifyingKey(SIGNING_KEY),
        two.dataToSign,
        signature,
      ),
    ).toBe(false);
  });

  it('should keep the signing key out of the rendered update', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(update.toString(false)).not.toContain(SIGNING_KEY_HEX);
  });

  it('should refuse an empty insert list', () => {
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
  it('should wrap the update in an intent with no calls and no offers', () => {
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

  it('should keep the signing key out of the rendered tx', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 0,
    });

    expect(buildInsertTx({ update }).toString(false)).not.toContain(
      SIGNING_KEY_HEX,
    );
  });
});

describe('buildInsertUpdate committee slot', () => {
  it('should sign at the slot it was given, not slot 0', () => {
    const update = buildInsertUpdate({
      address: ADDRESS,
      inserts: inserts('increment'),
      counter: 0n,
      signingKey: SIGNING_KEY,
      signerIndex: 2,
    });

    const [index, signature] = update.signatures[0] as [bigint, Signature];
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
