import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { EcdsaSimulator } from './EcdsaSimulator.js';

// Deterministic inputs: a fixed secret key plus RFC 6979 signing yields a stable
// signature, so the vector below is reproducible without any randomness.
const SK = Uint8Array.from({ length: 32 }, (_, i) => i + 1); // 0x0102…20 — a valid scalar
const pubAffine = secp256k1.Point.fromBytes(
  secp256k1.getPublicKey(SK),
).toAffine();
const pk = { x: pubAffine.x, y: pubAffine.y, identity: false };

const msg = new Uint8Array(32).fill(0xab);
// The circuit hashes msg with keccak256, so sign the keccak digest off-circuit.
const signed = secp256k1.Signature.fromBytes(
  secp256k1.sign(keccak_256(msg), SK, { format: 'recovered', prehash: false }),
  'recovered',
);
const sig = { r: signed.r, s: signed.s };
// Bump s so the signature no longer verifies.
const tampered = { r: signed.r, s: signed.s + 1n };

describe('[ECDSA] simulator runs secp256k1EcdsaVerify end-to-end', () => {
  let sim: EcdsaSimulator;
  beforeAll(async () => {
    sim = await EcdsaSimulator.create();
  });

  it('pure verifyEthereum accepts a valid signature', async () => {
    expect(await sim.verifyEthereum(msg, sig, pk)).toBe(true);
  });

  it('pure verifyEthereum rejects a tampered signature', async () => {
    expect(await sim.verifyEthereum(msg, tampered, pk)).toBe(false);
  });

  it('impure verifyAndStore records a valid result on-ledger', async () => {
    expect(await sim.verifyAndStore(msg, sig, pk)).toBe(true);
    expect((await sim.getPublicState()).lastVerified).toBe(true);
  });

  it('impure verifyAndStore records a tampered result as false', async () => {
    expect(await sim.verifyAndStore(msg, tampered, pk)).toBe(false);
    expect((await sim.getPublicState()).lastVerified).toBe(false);
  });
});
