import { describe, expect, it } from 'vitest';
import { PrivateStateMutator } from '../../../src/core/PrivateStateMutator.js';

type PS = { a: number; b: number };

/** A mutator over an in-memory state, for exercising the queue in isolation. */
const makeMutator = (initial: PS) => {
  let state = initial;
  const mutator = new PrivateStateMutator<PS>(
    async () => state,
    async (next) => {
      state = next;
    },
  );
  return { mutator, get: () => state };
};

describe('PrivateStateMutator', () => {
  it('set replaces the whole state', async () => {
    const { mutator, get } = makeMutator({ a: 1, b: 2 });
    await mutator.set({ a: 9, b: 9 });
    expect(get()).toEqual({ a: 9, b: 9 });
  });

  it('update shallow-merges a patch and resolves to the written state', async () => {
    const { mutator, get } = makeMutator({ a: 1, b: 2 });
    const next = await mutator.update({ b: 5 });
    expect(next).toEqual({ a: 1, b: 5 });
    expect(get()).toEqual({ a: 1, b: 5 });
  });

  it('update supports the updater-function form', async () => {
    const { mutator } = makeMutator({ a: 1, b: 2 });
    const next = await mutator.update((prev) => ({ ...prev, a: prev.a + 10 }));
    expect(next).toEqual({ a: 11, b: 2 });
  });

  it('serializes concurrent updates so neither patch is lost', async () => {
    const { mutator, get } = makeMutator({ a: 0, b: 0 });
    await Promise.all([mutator.update({ a: 1 }), mutator.update({ b: 2 })]);
    expect(get()).toEqual({ a: 1, b: 2 });
  });

  it('propagates a rejection to its caller', async () => {
    const { mutator } = makeMutator({ a: 1, b: 2 });
    await expect(
      mutator.enqueue(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('runs a mutation queued after a rejected one (queue not poisoned)', async () => {
    const { mutator, get } = makeMutator({ a: 0, b: 0 });
    // Enqueue a failing op and a following op back-to-back: the following op is
    // chained onto the tail while the first is still pending.
    const failing = mutator.enqueue(async () => {
      throw new Error('nope');
    });
    const following = mutator.set({ a: 7, b: 7 });

    await expect(failing).rejects.toThrow('nope');
    await expect(following).resolves.toBeUndefined();
    expect(get()).toEqual({ a: 7, b: 7 });
  });
});
