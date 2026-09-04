/** Cap on the JSON fallback so one wallet-SDK payload can't flood a log line. */
const MAX_SERIALIZED_LENGTH = 500;

/**
 * Render an unknown thrown value as a log-safe one-liner.
 *
 * The wallet SDK rejects with effect-style tagged records
 * (`{ _tag: 'Wallet.Sync', … }`) rather than `Error` instances, so the
 * usual `(e as Error).message` yields `undefined` and `${e}` yields
 * `[object Object]` — both erase the only diagnostic the user gets for a
 * failed sync. Prefer `_tag` plus `message`/`cause`, else serialize.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
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
 * JSON with a length cap. `bigint` needs a replacer (wallet-SDK payloads
 * carry balances and event ids) and a circular graph throws, so both fall
 * back to `String` rather than taking down the log call.
 */
function serialize(value: unknown): string {
  let out: string;
  try {
    out =
      JSON.stringify(value, (_key, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      ) ?? String(value);
  } catch {
    out = String(value);
  }
  return out.length > MAX_SERIALIZED_LENGTH
    ? `${out.slice(0, MAX_SERIALIZED_LENGTH)}…`
    : out;
}
