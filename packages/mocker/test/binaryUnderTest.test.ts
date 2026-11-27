import { describe, expect, it } from 'vitest';
import {
  binaryUnderTest,
  DEBUG_BINARY,
  RELEASE_BINARY,
} from './binaryUnderTest.ts';

const present = () => true;
const absent = () => false;
const only = (path: string) => (candidate: string) => candidate === path;
const reason =
  'no binary at /opt/compact-mock; build crates/compact-mock or set COMPACT_MOCK_BINARY';

describe('binaryUnderTest', () => {
  it('prefers COMPACT_MOCK_BINARY over the local builds', () => {
    expect(
      binaryUnderTest({ COMPACT_MOCK_BINARY: '/opt/compact-mock' }, present),
    ).toStrictEqual({ binary: '/opt/compact-mock' });
  });

  it('falls back to the release build, then the debug build', () => {
    expect(binaryUnderTest({}, present)).toStrictEqual({
      binary: RELEASE_BINARY,
    });
    expect(binaryUnderTest({}, only(DEBUG_BINARY))).toStrictEqual({
      binary: DEBUG_BINARY,
    });
  });

  it('skips with the reason when the binary is missing locally', () => {
    expect(
      binaryUnderTest({ COMPACT_MOCK_BINARY: '/opt/compact-mock' }, absent),
    ).toStrictEqual({ binary: '/opt/compact-mock', skip: reason });
    expect(binaryUnderTest({}, absent).skip).toBe(
      `no binary at ${RELEASE_BINARY} or ${DEBUG_BINARY}; build crates/compact-mock or set COMPACT_MOCK_BINARY`,
    );
  });

  it('fails with the reason when the binary is missing under CI', () => {
    expect(() =>
      binaryUnderTest(
        { CI: 'true', COMPACT_MOCK_BINARY: '/opt/compact-mock' },
        absent,
      ),
    ).toThrow(reason);
  });
});
