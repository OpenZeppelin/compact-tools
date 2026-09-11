import { describe, expect, it } from 'vitest';
import {
  fragmentRemainder,
  planFragments,
  remaining,
  sortCircuits,
} from './deploy-plan.ts';

/** Deterministic pseudo-random circuit lists, so a failure reproduces. */
function circuitList(seed: number, size: number): string[] {
  const out: string[] = [];
  let state = seed;
  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) % 2147483648;
    out.push(`circuit_${state.toString(36)}_${i}`);
  }
  return out;
}

describe('planFragments', () => {
  // INV-1
  it('partitions the input across fragments', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const circuits = circuitList(seed, (seed % 19) + 1);
      const budget = (seed % 7) + 1;
      const { fragments } = planFragments(circuits, budget);

      const flat = fragments.flatMap((f) => f.circuits);
      expect(new Set(flat).size).toBe(flat.length);
      expect([...flat].sort()).toStrictEqual(sortCircuits(circuits));
      expect(fragments.every((f) => f.circuits.length > 0)).toBe(true);
      expect(fragments.map((f) => f.index)).toStrictEqual(
        fragments.map((_f, i) => i),
      );
      expect(fragments.every((f) => f.circuits.length <= budget)).toBe(true);
    }
  });

  // INV-1
  it('returns no fragments for an empty circuit list', () => {
    expect(planFragments([], 4).fragments).toStrictEqual([]);
  });

  // INV-2
  it('ignores input order and repeats identically', () => {
    const circuits = ['zeta', 'alpha', 'Mu', 'beta'];
    const first = planFragments(circuits, 2);
    const second = planFragments([...circuits].reverse(), 2);

    expect(second).toStrictEqual(first);
    expect(planFragments(circuits, 2)).toStrictEqual(first);
  });

  // INV-2
  it('puts the first sorted names in fragment 0', () => {
    const plan = planFragments(['d', 'b', 'a', 'c', 'e'], 2);

    expect(plan.circuits).toStrictEqual(['a', 'b', 'c', 'd', 'e']);
    expect(plan.fragments.map((f) => f.circuits)).toStrictEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });
});

describe('remaining', () => {
  // INV-10
  it('returns the artifact circuits absent from chain, sorted', () => {
    expect(remaining(['c', 'a', 'b'], ['b'])).toStrictEqual(['a', 'c']);
  });

  // INV-10
  it('returns nothing when chain already holds every circuit', () => {
    expect(remaining(['a', 'b'], ['b', 'a', 'extra'])).toStrictEqual([]);
  });
});

describe('fragmentRemainder', () => {
  // INV-10
  it('drops the fragment circuits already on chain', () => {
    const fragment = { index: 1, circuits: ['a', 'b', 'c'] };

    expect(fragmentRemainder(fragment, ['b'])).toStrictEqual(['a', 'c']);
    expect(fragmentRemainder(fragment, ['a', 'b', 'c'])).toStrictEqual([]);
  });
});
