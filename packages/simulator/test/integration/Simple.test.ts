import { beforeEach, describe, expect, it } from 'vitest';
import { SimpleSimulator } from './SimpleSimulator.js';

let simple: SimpleSimulator;

describe('Simple test', () => {
  beforeEach(async () => {
    simple = await SimpleSimulator.create();
  });

  it('sanity check', () => {
    expect(1).toEqual(1);
  });

  it('should set val', async () => {
    const VAL = 123n;
    await simple.setVal(VAL);
    expect(await simple.getVal()).toEqual(VAL);
  });
});
