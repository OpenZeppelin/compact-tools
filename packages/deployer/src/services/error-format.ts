import { inspect } from 'node:util';

/** Cap on the inspect fallback so one wallet-SDK payload can't flood a log line. */
const MAX_SERIALIZED_LENGTH = 500;

/**
 * `Runtime.FiberFailureCauseId` from `effect`, referenced by its registered
 * symbol so this package needs no runtime dependency on `effect`.
 */
const EFFECT_FIBER_FAILURE_CAUSE = Symbol.for(
  'effect/Runtime/FiberFailure/Cause',
);

/**
 * Render an unknown thrown value as a log-safe one-liner.
 *
 * The wallet SDK rejects with effect-style tagged records
 * (`{ _tag: 'Wallet.Sync', … }`) rather than `Error` instances, so the
 * usual `(e as Error).message` yields `undefined` and `${e}` yields
 * `[object Object]` — both erase the only diagnostic the user gets for a
 * failed sync. Prefer `_tag` plus `message`/`cause`, else inspect.
 */
export function formatError(error: unknown): string {
  const fiberFailure = effectFailure(error);
  if (fiberFailure !== undefined) return formatError(fiberFailure);
  if (error instanceof Error) {
    if (error.cause === undefined) return error.message;
    // The wrapping layer's message is usually the generic half ("Deploy
    // failed"); the cause carries the reason. Append it so one log line
    // holds the whole chain. A layer that re-wrapped its own failure with
    // `message: cause.message` contributes nothing, so keep only the deeper
    // rendering.
    const cause = formatError(error.cause);
    return cause.startsWith(error.message)
      ? cause
      : `${error.message}: ${cause}`;
  }
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const record = error as {
      _tag?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    const tag = typeof record._tag === 'string' ? record._tag : undefined;
    const detail =
      typeof record.message === 'string' && record.message !== ''
        ? record.message
        : record.cause !== undefined
          ? formatError(record.cause)
          : undefined;
    if (tag !== undefined) {
      return `${tag}: ${detail ?? serialize(error)}`;
    }
    if (detail !== undefined) return detail;
  }
  return serialize(error);
}

/**
 * The failed value inside an Effect `FiberFailure`, or `undefined` for any
 * other thrown value.
 *
 * `Effect.runPromise` rejects with a wrapper that copies only the squashed
 * failure's `message` and leaves `cause` unset, so the wallet SDK's proving
 * chain (`Wallet.Proving` → `ClientError` → the connection error naming the
 * proof server) is reachable only through the cause symbol.
 */
function effectFailure(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const cause = (error as Record<symbol, unknown>)[EFFECT_FIBER_FAILURE_CAUSE];
  if (typeof cause !== 'object' || cause === null) return undefined;
  const squashed = cause as {
    _tag?: unknown;
    error?: unknown;
    defect?: unknown;
  };
  if (squashed._tag === 'Fail') return squashed.error;
  if (squashed._tag === 'Die') return squashed.defect;
  return undefined;
}

/**
 * `util.inspect` with a length cap. Unlike `JSON.stringify` it renders
 * `bigint` (wallet-SDK payloads carry balances and event ids as bigint)
 * and marks circular references instead of throwing, so no try/catch or
 * replacer is needed. `depth: 3` keeps a nested payload readable without
 * dumping the whole graph.
 */
function serialize(value: unknown): string {
  const out = inspect(value, {
    depth: 3,
    breakLength: Number.POSITIVE_INFINITY,
  });
  return out.length > MAX_SERIALIZED_LENGTH
    ? `${out.slice(0, MAX_SERIALIZED_LENGTH)}…`
    : out;
}
