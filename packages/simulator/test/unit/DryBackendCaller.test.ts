import { describe, expect, it } from 'vitest';
import {
  DryBackend,
  type SyncSimulator,
} from '../../src/backend/DryBackend.js';
import { Signers } from '../../src/signers/Signers.js';

const makeBackend = () => {
  const sim = {
    callerOverride: null,
    persistentCallerOverride: null,
    circuits: { pure: {}, impure: {} },
  } as unknown as SyncSimulator<object, object>;
  const backend = new DryBackend(sim, new Signers({ mode: 'dry' }));
  return { backend, sim };
};

describe('the as() caller on the dry backend', () => {
  it.each(['pure', 'impure'] as const)(
    'spends the as() caller when the %s circuit is unknown',
    async (kind) => {
      const { backend, sim } = makeBackend();

      backend.setCaller('ALICE', 'single');
      await expect(backend.call(kind, 'missing', [])).rejects.toThrow(
        `unknown ${kind} circuit "missing"`,
      );

      expect(sim.callerOverride).toBeNull();
    },
  );
});
