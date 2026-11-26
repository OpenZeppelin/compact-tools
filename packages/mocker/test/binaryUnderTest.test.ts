import { describe, expect, it } from 'vitest';
import { BUILT_BINARY, binaryUnderTest } from './binaryUnderTest.ts';

const present = () => true;
const absent = () => false;
const reason =
  'no binary at /opt/compact-mock; build crates/compact-mock or set COMPACT_MOCK_BINARY';

describe('binaryUnderTest', () => {
  it('prefers COMPACT_MOCK_BINARY over the local build', () => {
    expect(
      binaryUnderTest({ COMPACT_MOCK_BINARY: '/opt/compact-mock' }, present),
    ).toStrictEqual({ binary: '/opt/compact-mock' });
    expect(binaryUnderTest({}, present)).toStrictEqual({
      binary: BUILT_BINARY,
    });
  });

  it('skips with the reason when the binary is missing locally', () => {
    expect(
      binaryUnderTest({ COMPACT_MOCK_BINARY: '/opt/compact-mock' }, absent),
    ).toStrictEqual({ binary: '/opt/compact-mock', skip: reason });
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
