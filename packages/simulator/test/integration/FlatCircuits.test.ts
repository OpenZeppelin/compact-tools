import { describe, expect, it } from 'vitest';
import { RESERVED_FLAT_NAMES } from '../../src/factory/createSimulator.js';
import { isLiveBackend } from '../../src/index.js';
import {
  FlatBase,
  FlatSimulator,
  type FlatWitnessSet,
  ToJSONBase,
  UntypedFlatSimulator,
} from './FlatSimulator.js';

const IMPURE = [
  'bump',
  'setFromWitness',
  'recordCaller',
  'mintToCaller',
  'getPublicState',
  'signers',
  'then',
  'labelled',
  'described',
];
const PURE = ['add', 'toString'];
const INSTALLED = [
  'bump',
  'setFromWitness',
  'recordCaller',
  'mintToCaller',
  'labelled',
  'described',
  'add',
];

const witnessValue =
  (value: bigint): FlatWitnessSet['wit_value'] =>
  ({ privateState }) => [privateState, value];

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// Dry only: `create` gets no LiveContext here, as no live backend is registered.
describe.skipIf(isLiveBackend())('flat circuit methods', () => {
  describe('install set', () => {
    it('gives every circuit an own method except base members, Object.prototype names and then', async () => {
      const sim = await FlatBase.create();
      const circuitNames = new Set([...IMPURE, ...PURE]);

      expect(Object.keys(sim.circuits.impure).sort()).toEqual(
        [...IMPURE].sort(),
      );
      expect(Object.keys(sim.circuits.pure).sort()).toEqual([...PURE].sort());
      expect(
        Object.getOwnPropertyNames(sim)
          .filter((name) => circuitNames.has(name))
          .sort(),
      ).toEqual([...INSTALLED].sort());
    });

    it('installs non-enumerable, configurable, writable properties', async () => {
      const sim = await FlatBase.create();

      for (const name of INSTALLED) {
        expect(Object.getOwnPropertyDescriptor(sim, name)).toMatchObject({
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
      expect(Object.keys(sim)).not.toContain('bump');
      expect(Object.keys({ ...sim })).not.toContain('bump');
    });

    it('adds nothing to the prototype or the constructor', async () => {
      await FlatBase.create();

      for (const name of INSTALLED) {
        expect(Object.hasOwn(FlatBase.prototype, name)).toBe(false);
        expect(Object.hasOwn(FlatBase, name)).toBe(false);
      }
      expect(FlatBase.name).toBe('Simulator');
    });

    it('installs the methods without flatCircuits', async () => {
      const sim = await UntypedFlatSimulator.create();
      const flat = sim as unknown as { bump(): Promise<[]> };

      await flat.bump();

      expect(Object.hasOwn(sim, 'bump')).toBe(true);
      expect((await sim.getPublicState())._count).toBe(1n);
    });

    it('reserves every Object.prototype name', () => {
      const reserved: readonly string[] = RESERVED_FLAT_NAMES;

      for (const name of Object.getOwnPropertyNames(Object.prototype)) {
        expect(reserved).toContain(name);
      }
      expect(reserved).toContain('then');
    });
  });

  describe('calls', () => {
    it('runs an impure circuit', async () => {
      const sim = await FlatBase.create();

      await sim.bump();
      await sim.bump();

      expect((await sim.getPublicState())._count).toBe(2n);
    });

    it('runs a pure circuit', async () => {
      const sim = await FlatBase.create();

      expect(await sim.add(20n, 22n)).toBe(42n);
    });

    it('returns what the circuits proxy returns, with the same state change', async () => {
      const sim = await FlatBase.create();

      const flat = await sim.labelled();
      const proxied = await sim.circuits.impure.labelled();

      expect(flat).toBe(proxied);
      expect((await sim.getPublicState())._count).toBe(2n);
      expect(await sim.add(1n, 2n)).toBe(await sim.circuits.pure.add(1n, 2n));
    });

    it('takes the caller from as() and setPersistentCaller()', async () => {
      const sim = await FlatBase.create();

      await sim.as('ALICE').recordCaller();
      const single = hex((await sim.getPublicState())._caller.bytes);
      sim.setPersistentCaller('BOB');
      await sim.recordCaller();
      const persistent = hex((await sim.getPublicState())._caller.bytes);

      expect(single).toBe(sim.signers.resolveDryKey('ALICE'));
      expect(persistent).toBe(sim.signers.resolveDryKey('BOB'));
    });

    it('routes each instance to its own backend, also when detached', async () => {
      const a = await FlatBase.create();
      const b = await FlatBase.create();
      const { bump } = a;

      await bump();
      await a.bump.call(b);

      expect((await a.getPublicState())._count).toBe(2n);
      expect((await b.getPublicState())._count).toBe(0n);
    });
  });

  describe('lazy dispatch', () => {
    it('uses a witness overridden after construction', async () => {
      const sim = await FlatBase.create();

      await sim.setFromWitness();
      const before = (await sim.getPublicState())._last;
      sim.overrideWitness('wit_value', witnessValue(9n));
      await sim.setFromWitness();

      expect(before).toBe(5n);
      expect((await sim.getPublicState())._last).toBe(9n);
    });

    it('uses witnesses replaced after construction', async () => {
      const sim = await FlatBase.create();

      sim.setWitnesses({ wit_value: witnessValue(11n) });
      await sim.setFromWitness();

      expect((await sim.getPublicState())._last).toBe(11n);
    });

    it('reads the circuits proxy on every call', async () => {
      const sim = await FlatBase.create();
      const impure = sim.circuits.impure as Record<
        string,
        (...args: unknown[]) => Promise<unknown>
      >;

      impure.bump = async () => 'replaced';

      expect(await sim.bump()).toBe('replaced');
      expect((await sim.getPublicState())._count).toBe(0n);
    });
  });

  describe('names the instance already has', () => {
    it('keeps the base getPublicState and reaches the circuit through circuits', async () => {
      const sim = await FlatBase.create();
      await sim.bump();

      const state = await sim.getPublicState();

      expect(state._count).toBe(1n);
      expect(await sim.circuits.impure.getPublicState()).toBe(1n);
      expect(Object.hasOwn(sim, 'getPublicState')).toBe(false);
    });

    it('keeps the signers accessor', async () => {
      const sim = await FlatBase.create();

      expect(sim.signers).toBe(sim._signers);
      await sim.circuits.impure.signers();
      expect((await sim.getPublicState())._count).toBe(1n);
    });

    it('keeps Object.prototype.toString and reaches the pure circuit through circuits', async () => {
      const sim = await FlatBase.create();

      expect(sim.toString()).toBe('[object Object]');
      expect(Object.hasOwn(sim, 'toString')).toBe(false);
      expect(await sim.circuits.pure.toString()).toBe(7n);
    });

    it('lets a subclass field replace the method on a typed flat class', async () => {
      const sim = await FlatSimulator.create();

      expect(await sim.labelled()).toBe(100n);
      expect((await sim.getPublicState())._count).toBe(0n);
      expect(await sim.circuits.impure.labelled()).toBe(1n);
    });

    it('lets a subclass method win on a class without flatCircuits', async () => {
      const sim = await UntypedFlatSimulator.create();

      expect(await sim.described()).toBe(200n);
      expect(Object.hasOwn(sim, 'described')).toBe(false);
      expect((await sim.getPublicState())._count).toBe(0n);
      expect(await sim.circuits.impure.described()).toBe(2n);
    });
  });

  describe('then', () => {
    it('is not installed, so create() resolves to the instance', async () => {
      const sim = await FlatSimulator.create();

      expect(sim).toBeInstanceOf(FlatSimulator);
      expect('then' in sim).toBe(false);
    });

    it('stays reachable through circuits', async () => {
      const sim = await FlatBase.create();

      await sim.circuits.impure.then();

      expect((await sim.getPublicState())._count).toBe(1n);
    });
  });

  describe('toJSON', () => {
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    it('is not installed, so JSON.stringify does not call the circuit, which circuits reaches', async () => {
      const sim = await ToJSONBase.create();
      const impure = sim.circuits.impure as unknown as Record<
        string,
        () => Promise<[]>
      >;

      // The replacer drops every key, so only a `toJSON` call has an effect.
      JSON.stringify(sim, (key, value) => (key === '' ? value : undefined));
      await settle();
      const afterStringify = (await sim.getPublicState())._count;
      await impure.toJSON();

      expect('toJSON' in sim).toBe(false);
      expect(afterStringify).toBe(0n);
      expect((await sim.getPublicState())._count).toBe(1n);
    });
  });
});
