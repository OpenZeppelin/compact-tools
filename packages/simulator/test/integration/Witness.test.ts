import { beforeEach, describe, expect, it } from 'vitest';
import type {
  IWitnessWitnesses,
  WitnessPrivateState,
} from '../fixtures/sample-contracts/witnesses/WitnessWitnesses';
import { WitnessSimulator } from './WitnessSimulator';

const VAL1 = 3n;
const VAL2 = 7n;
const BYTES_OVERRIDE = new Uint8Array(32).fill(1);
const FIELD_OVERRIDE = 222n;
const UINT_OVERRIDE = 333n;

const overrideWitnesses = (): IWitnessWitnesses<
  unknown,
  WitnessPrivateState
> => ({
  wit_secretBytes(ctx) {
    return [ctx.privateState, BYTES_OVERRIDE];
  },
  wit_secretFieldPlusArg(ctx) {
    return [ctx.privateState, FIELD_OVERRIDE];
  },
  wit_secretUintPlusArgs(ctx) {
    return [ctx.privateState, UINT_OVERRIDE];
  },
});

let contract: WitnessSimulator;

describe('witness/private state overrides', () => {
  beforeEach(async () => {
    contract = await WitnessSimulator.create();
  });

  describe('witness overrides', () => {
    it('should have default public state values', async () => {
      expect((await contract.getPublicState())._valBytes).toEqual(
        new Uint8Array(32).fill(0),
      );
      expect((await contract.getPublicState())._valField).toEqual(0n);
      expect((await contract.getPublicState())._valUint).toEqual(0n);
    });

    it('should set values according to witness logic', async () => {
      // Private state
      const ps = await contract.getPrivateState();
      const psBytes = ps.secretBytes;
      const psField = ps.secretField;
      const psUint = ps.secretUint;

      // Set values
      await contract.setBytes();
      await contract.setField(VAL1);
      await contract.setUint(VAL1, VAL2);

      // Check values
      expect((await contract.getPublicState())._valBytes).toEqual(
        new Uint8Array(psBytes),
      );
      expect((await contract.getPublicState())._valField).toEqual(
        psField + VAL1,
      );
      expect((await contract.getPublicState())._valUint).toEqual(
        psUint + VAL1 + VAL2,
      );
    });

    it('should override all witnesses', async () => {
      // Private state
      const ps = await contract.getPrivateState();
      const psBytes = ps.secretBytes;
      const psField = ps.secretField;
      const psUint = ps.secretUint;

      // Override entire object
      contract.witnesses = overrideWitnesses();

      // Set values
      await contract.setBytes();
      await contract.setField(VAL1);
      await contract.setUint(VAL1, VAL2);

      // Check bytes
      expect((await contract.getPublicState())._valBytes).toEqual(
        BYTES_OVERRIDE,
      );
      expect((await contract.getPublicState())._valBytes).not.toEqual(
        new Uint8Array(psBytes),
      );

      // Check field
      expect((await contract.getPublicState())._valField).toEqual(
        FIELD_OVERRIDE,
      );
      expect((await contract.getPublicState())._valField).not.toEqual(
        psField + VAL1,
      );

      // Check uint
      expect((await contract.getPublicState())._valUint).toEqual(UINT_OVERRIDE);
      expect((await contract.getPublicState())._valUint).not.toEqual(
        psUint + VAL1 + VAL2,
      );
    });

    describe('when overriding individual witnesses', () => {
      it('should override wit_secretBytes', async () => {
        // Private state
        const ps = await contract.getPrivateState();
        const psBytes = ps.secretBytes;
        const psField = ps.secretField;
        const psUint = ps.secretUint;

        contract.overrideWitness('wit_secretBytes', (ctx) => {
          return [ctx.privateState, BYTES_OVERRIDE];
        });

        // Set all values
        await contract.setBytes();
        await contract.setField(VAL1);
        await contract.setUint(VAL1, VAL2);

        // Check bytes override
        expect((await contract.getPublicState())._valBytes).toEqual(
          BYTES_OVERRIDE,
        );
        expect((await contract.getPublicState())._valBytes).not.toEqual(
          new Uint8Array(psBytes),
        );

        // Check other witnesses remain unchanged
        expect((await contract.getPublicState())._valField).toEqual(
          psField + VAL1,
        );
        expect((await contract.getPublicState())._valUint).toEqual(
          psUint + VAL1 + VAL2,
        );
      });

      it('should override wit_secretFieldPlusArg', async () => {
        // Private state
        const ps = await contract.getPrivateState();
        const psBytes = ps.secretBytes;
        const psUint = ps.secretUint;

        contract.overrideWitness('wit_secretFieldPlusArg', (ctx) => {
          return [ctx.privateState, FIELD_OVERRIDE];
        });

        // Set all values
        await contract.setBytes();
        await contract.setField(VAL1);
        await contract.setUint(VAL1, VAL2);

        // Check field override
        expect((await contract.getPublicState())._valField).toEqual(
          FIELD_OVERRIDE,
        );
        expect((await contract.getPublicState())._valField).not.toEqual(VAL1);

        // Check other witnesses remain unchanged
        expect((await contract.getPublicState())._valBytes).toEqual(
          new Uint8Array(psBytes),
        );
        expect((await contract.getPublicState())._valUint).toEqual(
          psUint + VAL1 + VAL2,
        );
      });

      it('should override wit_secretUintPlusArgs', async () => {
        // Private state
        const ps = await contract.getPrivateState();
        const psBytes = ps.secretBytes;
        const psField = ps.secretField;
        const psUint = ps.secretUint;

        contract.overrideWitness('wit_secretUintPlusArgs', (ctx) => {
          return [ctx.privateState, UINT_OVERRIDE];
        });

        // Set all values
        await contract.setBytes();
        await contract.setField(VAL1);
        await contract.setUint(VAL1, VAL2);

        // Check uint override
        expect((await contract.getPublicState())._valUint).toEqual(
          UINT_OVERRIDE,
        );
        expect((await contract.getPublicState())._valUint).not.toEqual(
          psUint + VAL1 + VAL2,
        );

        // Check other witnesses remain unchanged
        expect((await contract.getPublicState())._valBytes).toEqual(
          new Uint8Array(psBytes),
        );
        expect((await contract.getPublicState())._valField).toEqual(
          psField + VAL1,
        );
      });
    });
  });

  describe('private state mutation', () => {
    it('replaces the whole private state via setPrivateState', async () => {
      const next: WitnessPrivateState = {
        secretBytes: Buffer.alloc(32, 5),
        secretField: 11n,
        secretUint: 22n,
      };
      await contract.setPrivateState(next);
      expect(await contract.getPrivateState()).toEqual(next);
    });

    it('patch-merges only the given fields, preserving the rest', async () => {
      const before = await contract.getPrivateState();
      await contract.updatePrivateState({ secretField: FIELD_OVERRIDE });

      const after = await contract.getPrivateState();
      expect(after.secretField).toEqual(FIELD_OVERRIDE);
      // Untouched fields survive the merge.
      expect(after.secretBytes).toEqual(before.secretBytes);
      expect(after.secretUint).toEqual(before.secretUint);
    });

    it('supports the updater-function form (prev → next)', async () => {
      const before = await contract.getPrivateState();
      await contract.updatePrivateState((prev) => ({
        ...prev,
        secretUint: prev.secretUint + 100n,
      }));
      expect((await contract.getPrivateState()).secretUint).toEqual(
        before.secretUint + 100n,
      );
    });

    it('serializes concurrent updates so neither patch is lost', async () => {
      const before = await contract.getPrivateState();
      // Both read the same prev if unserialized; the last write would then
      // clobber the other field. Serialization must land both.
      await Promise.all([
        contract.updatePrivateState({ secretField: 77n }),
        contract.updatePrivateState({ secretUint: 88n }),
      ]);

      const after = await contract.getPrivateState();
      expect(after.secretField).toEqual(77n);
      expect(after.secretUint).toEqual(88n);
      expect(after.secretBytes).toEqual(before.secretBytes);
    });

    it('feeds mutated private state into subsequent circuit calls', async () => {
      // secretBytes is written to public state by setBytes() via the witness.
      const injected = Buffer.alloc(32, 9);
      await contract.updatePrivateState({ secretBytes: injected });
      await contract.setBytes();
      expect((await contract.getPublicState())._valBytes).toEqual(
        new Uint8Array(injected),
      );
    });
  });
});
