import { AsyncLocalStorage } from 'node:async_hooks';
import type { Backend } from '../backend/Backend.js';

type CallerBackend = Pick<Backend<unknown, unknown>, 'consumeSingleCaller'>;

/**
 * A running circuit replacement: the `as()` caller it took when it started,
 * which its first circuit call uses.
 */
interface Scope {
  readonly backend: CallerBackend;
  restore: (() => void) | undefined;
}

const scopes = new AsyncLocalStorage<Scope>();

/**
 * Runs a function `extend` adds in place of a circuit method. It takes the
 * `as()` caller before `run` starts, so an overlapping call does not reuse it,
 * and keeps it for the first circuit call `run` makes, also after an `await`.
 */
export function runReplacement<T>(backend: CallerBackend, run: () => T): T {
  const outer = scopes.getStore();
  let restore: (() => void) | undefined;
  if (outer?.backend === backend && outer.restore) {
    restore = outer.restore;
    outer.restore = undefined;
  } else {
    restore = backend.consumeSingleCaller();
  }
  return scopes.run({ backend, restore }, run);
}

/**
 * Starts a circuit call. Inside a replacement that still holds its caller,
 * the call runs as that caller, and an `as()` caller set outside the
 * replacement stays pending for the next call.
 */
export function startCall<T>(backend: CallerBackend, call: () => T): T {
  const scope = scopes.getStore();
  if (scope?.backend !== backend || !scope.restore) return call();
  const held = scope.restore;
  scope.restore = undefined;
  const newer = backend.consumeSingleCaller();
  held();
  try {
    // The backend takes the caller before its first `await`.
    return call();
  } finally {
    newer();
  }
}

/** An `as()` inside a replacement replaces the caller the replacement holds. */
export function releaseHeldCaller(backend: CallerBackend): void {
  const scope = scopes.getStore();
  if (scope?.backend === backend) scope.restore = undefined;
}
