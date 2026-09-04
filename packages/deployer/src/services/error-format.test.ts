import { describe, expect, it } from 'vitest';
import { formatError } from './error-format.ts';

describe('formatError', () => {
  it('should render an Error as its message', () => {
    expect(formatError(new Error('disk full'))).toStrictEqual('disk full');
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
      'Wallet.Sync: {"_tag":"Wallet.Sync","eventId":571224}',
    );
  });

  it('should serialize an untagged object', () => {
    expect(formatError({ code: 'ENOENT' })).toStrictEqual('{"code":"ENOENT"}');
  });

  it('should stringify bigint fields instead of throwing on them', () => {
    // Wallet-SDK payloads carry balances and event ids as bigint, which
    // plain JSON.stringify rejects with a TypeError.
    expect(
      formatError({ _tag: 'Dust', highestIndex: 1_465_505n }),
    ).toStrictEqual('Dust: {"_tag":"Dust","highestIndex":"1465505"}');
  });

  it('should cap the serialized fallback at 500 characters plus an ellipsis', () => {
    const formatted = formatError({ blob: 'x'.repeat(2000) });
    expect(formatted.length).toStrictEqual(501);
    expect(formatted.endsWith('…')).toStrictEqual(true);
  });

  it('should fall back to String() on a circular payload', () => {
    const circular: Record<string, unknown> = { detail: 'loop' };
    circular.self = circular;
    expect(formatError(circular)).toStrictEqual('[object Object]');
  });

  it('should render null and undefined without throwing', () => {
    expect(formatError(null)).toStrictEqual('null');
    expect(formatError(undefined)).toStrictEqual('undefined');
  });
});
