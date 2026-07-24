/**
 * Serializes read-modify-write access to a contract's private state.
 *
 * Built from a backend's `getPrivateState`/`setPrivateState` pair, it queues
 * every mutation so a read-modify-write (`update`) can't interleave with another
 * mutation and lose an update (a lost-update race). It is backend-agnostic: the
 * dry, live, and future `sim` backends all reuse it by supplying their own
 * read/write closures.
 *
 * The guarantee is scoped to this instance. On live, two `PrivateStateMutator`s
 * (or two processes) targeting the same `privateStateProvider` + `privateStateId`
 * still race — both read the provider, last write wins — since the queue is
 * local. Cross-instance atomicity would need provider-side
 * compare-and-set/versioning and is out of scope; tests drive one simulator per
 * private state, so the per-instance queue is sufficient in practice.
 *
 * @template P - Private state type.
 */
export class PrivateStateMutator<P> {
  /** Tail of the mutation queue; each op runs after the previous drains. */
  #chain: Promise<unknown> = Promise.resolve();
  readonly #read: () => Promise<P>;
  readonly #write: (next: P) => Promise<void>;

  /**
   * @param read - Reads the current private state (backend `getPrivateState`).
   * @param write - Replaces the whole private state (backend `setPrivateState`).
   */
  constructor(read: () => Promise<P>, write: (next: P) => Promise<void>) {
    this.#read = read;
    this.#write = write;
  }

  /**
   * Runs `op` once the queue drains, serialized against every other mutation.
   * The returned promise settles with `op`'s result (or rejection) for the
   * caller; the queue tail deliberately swallows rejections so a failed op does
   * not poison subsequent mutations.
   *
   * @param op - The operation to run once the queue drains.
   * @returns `op`'s result.
   */
  enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(op);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Replaces the whole private state, serialized against other mutations.
   *
   * @param next - The new private state.
   */
  set(next: P): Promise<void> {
    return this.enqueue(() => this.#write(next));
  }

  /**
   * Read-modify-write, serialized end-to-end so the read and write are atomic
   * against other mutations on this instance. Resolves to the state that was
   * written, so callers need no follow-up read.
   *
   * @param updater - A partial patch to shallow-merge, or a function that
   *   receives the current state and returns the next.
   * @returns The private state that was written.
   */
  update(updater: Partial<P> | ((prev: P) => P)): Promise<P> {
    return this.enqueue(async () => {
      const prev = await this.#read();
      const next =
        typeof updater === 'function'
          ? (updater as (p: P) => P)(prev)
          : { ...prev, ...updater };
      await this.#write(next);
      return next;
    });
  }
}
