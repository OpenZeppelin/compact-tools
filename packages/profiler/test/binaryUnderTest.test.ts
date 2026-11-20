import { describe, expect, it } from 'vitest';
import { BUILT_BINARY, binaryUnderTest } from './binaryUnderTest.ts';

const present = () => true;
const absent = () => false;
const reason =
  'no binary at /opt/compact-profile; build crates/compact-profile or set COMPACT_PROFILE_BINARY';

describe('binaryUnderTest', () => {
  it('prefers COMPACT_PROFILE_BINARY over the local build', () => {
    expect(
      binaryUnderTest(
        { COMPACT_PROFILE_BINARY: '/opt/compact-profile' },
        present,
      ),
    ).toStrictEqual({ binary: '/opt/compact-profile' });
    expect(binaryUnderTest({}, present)).toStrictEqual({
      binary: BUILT_BINARY,
    });
  });

  it('skips with the reason when the binary is missing locally', () => {
    expect(
      binaryUnderTest(
        { COMPACT_PROFILE_BINARY: '/opt/compact-profile' },
        absent,
      ),
    ).toStrictEqual({ binary: '/opt/compact-profile', skip: reason });
  });

  it('fails with the reason when the binary is missing under CI', () => {
    expect(() =>
      binaryUnderTest(
        { CI: 'true', COMPACT_PROFILE_BINARY: '/opt/compact-profile' },
        absent,
      ),
    ).toThrow(reason);
  });
});
