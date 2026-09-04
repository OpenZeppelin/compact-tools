import { describe, expect, it } from 'vitest';
import { formatError } from './error-format.ts';

describe('formatError', () => {
  it('should render an Error as its message', () => {
    expect(formatError(new Error('disk full'))).toStrictEqual('disk full');
  });

  it('should append the cause chain of a wrapped Error', () => {
    // The wrapper's message is the generic half; the cause carries why.
    const wrapped = new Error('Deploy failed', {
      cause: new Error('chain rejected'),
    });
    expect(formatError(wrapped)).toStrictEqual('Deploy failed: chain rejected');
  });

  it('should collapse a wrapper that only repeats its own cause message', () => {
    // The wallet SDK's proving service re-wraps its failure with
    // `message: error.message`, so the phrase would otherwise appear twice.
    const wrapped = new Error('Failed to prove transaction', {
      cause: new Error('Failed to prove transaction', {
        cause: new Error('connect ECONNREFUSED 127.0.0.1:6300'),
      }),
    });
    expect(formatError(wrapped)).toStrictEqual(
      'Failed to prove transaction: connect ECONNREFUSED 127.0.0.1:6300',
    );
  });

  it('should reach the failure inside an Effect FiberFailure', () => {
    // `Effect.runPromise` rejects with this shape: the squashed message is
    // copied onto the wrapper, `cause` is left unset, and the real error
    // hangs off the cause symbol.
    const fiberFailure = Object.assign(
      new Error('Failed to prove transaction'),
      {
        [Symbol.for('effect/Runtime/FiberFailure/Cause')]: {
          _tag: 'Fail',
          error: new Error('Failed to prove transaction', {
            cause: new Error('Failed to connect to Proof Server: fetch failed'),
          }),
        },
      },
    );
    expect(formatError(fiberFailure)).toStrictEqual(
      'Failed to prove transaction: Failed to connect to Proof Server: fetch failed',
    );
  });

  it('should reach the defect inside a died Effect FiberFailure', () => {
    const fiberFailure = Object.assign(new Error('boom'), {
      [Symbol.for('effect/Runtime/FiberFailure/Cause')]: {
        _tag: 'Die',
        defect: 'proof server returned no body',
      },
    });
    expect(formatError(fiberFailure)).toStrictEqual(
      'proof server returned no body',
    );
  });

  it('should fall back to the wrapper for a cause symbol it cannot read', () => {
    const interrupted = Object.assign(new Error('interrupted'), {
      [Symbol.for('effect/Runtime/FiberFailure/Cause')]: { _tag: 'Interrupt' },
    });
    expect(formatError(interrupted)).toStrictEqual('interrupted');
    const empty = Object.assign(new Error('no cause'), {
      [Symbol.for('effect/Runtime/FiberFailure/Cause')]: null,
    });
    expect(formatError(empty)).toStrictEqual('no cause');
  });

  it('should render a thrown string unchanged', () => {
    expect(formatError('plain failure')).toStrictEqual('plain failure');
  });

  it('should render a tagged wallet-SDK error as _tag plus message', () => {
    // The shape the wallet SDK rejects with: not an Error, so
    // `(e as Error).message` is undefined and `${e}` is [object Object].
    const tagged = {
      _tag: 'Wallet.Sync',
      message: 'Could not deserialize Ledger Event',
    };
    expect(formatError(tagged)).toStrictEqual(
      'Wallet.Sync: Could not deserialize Ledger Event',
    );
  });

  it('should fall back to the tagged error cause when it carries no message', () => {
    const tagged = { _tag: 'Wallet.Sync', cause: new Error('event id 571224') };
    expect(formatError(tagged)).toStrictEqual('Wallet.Sync: event id 571224');
  });

  it('should serialize a tagged error with neither message nor cause', () => {
    expect(formatError({ _tag: 'Wallet.Sync', eventId: 571224 })).toStrictEqual(
      "Wallet.Sync: { _tag: 'Wallet.Sync', eventId: 571224 }",
    );
  });

  it('should serialize an untagged object', () => {
    expect(formatError({ code: 'ENOENT' })).toStrictEqual("{ code: 'ENOENT' }");
  });

  it('should render bigint fields instead of throwing on them', () => {
    // Wallet-SDK payloads carry balances and event ids as bigint, which
    // plain JSON.stringify rejects with a TypeError.
    expect(
      formatError({ _tag: 'Dust', highestIndex: 1_465_505n }),
    ).toStrictEqual("Dust: { _tag: 'Dust', highestIndex: 1465505n }");
  });

  it('should cap the serialized fallback at 500 characters plus an ellipsis', () => {
    const formatted = formatError({ blob: 'x'.repeat(2000) });
    expect(formatted.length).toStrictEqual(501);
    expect(formatted.endsWith('…')).toStrictEqual(true);
  });

  it('should mark the back-reference on a circular payload', () => {
    const circular: Record<string, unknown> = { detail: 'loop' };
    circular.self = circular;
    expect(formatError(circular)).toStrictEqual(
      "<ref *1> { detail: 'loop', self: [Circular *1] }",
    );
  });

  it('should use the message of an untagged record that carries one', () => {
    expect(formatError({ message: 'socket hang up' })).toStrictEqual(
      'socket hang up',
    );
  });

  it('should render null and undefined without throwing', () => {
    expect(formatError(null)).toStrictEqual('null');
    expect(formatError(undefined)).toStrictEqual('undefined');
  });
});
