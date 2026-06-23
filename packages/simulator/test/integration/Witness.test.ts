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

const overrideWitnesses = (): IWitnessWitnesses<WitnessPrivateState> => ({
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

  describe('private state overrides', () => {
    it('should match ps ', async () => {
      // Private state
      const ps = await contract.getPrivateState();
      void ps.secretBytes;
      void ps.secretField;
      void ps.secretUint;
    });

    it('should override the entire private state', () => {});
  });
});
