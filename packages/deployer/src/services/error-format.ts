import { inspect } from 'node:util';

/** Cap on the inspect fallback so one wallet-SDK payload can't flood a log line. */
const MAX_SERIALIZED_LENGTH = 500;

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
  if (error instanceof Error) {
    // The wrapping layer's message is usually the generic half ("Deploy
    // failed"); the cause carries the reason. Append it so one log line
    // holds the whole chain.
    return error.cause !== undefined
      ? `${error.message}: ${formatError(error.cause)}`
      : error.message;
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
