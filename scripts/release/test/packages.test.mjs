import { describe, expect, it } from 'vitest';
import {
  dirForPackage,
  dirFromChangedFiles,
  packageForDir,
  RELEASABLE,
} from '../packages.mjs';

describe('dirForPackage', () => {
  it.each(Object.entries(RELEASABLE))(
    'maps %s to its directory',
    (dir, name) => {
      expect(dirForPackage(name)).toBe(dir);
    },
  );

  it('rejects a package outside the release rotation', () => {
    expect(() => dirForPackage('compact-deployer')).toThrow(/unknown package/);
  });

  it('rejects a scoped name', () => {
    expect(() => dirForPackage('@openzeppelin/compact-cli')).toThrow(
      /unknown package/,
    );
  });
});

describe('packageForDir', () => {
  it.each(Object.entries(RELEASABLE))(
    'maps %s to its package name',
    (dir, name) => {
      expect(packageForDir(dir)).toBe(name);
    },
  );

  it('rejects a directory outside the release rotation', () => {
    expect(() => packageForDir('deployer')).toThrow(
      /unknown package directory/,
    );
  });
});

describe('dirFromChangedFiles', () => {
  it('resolves the single bumped package', () => {
    expect(dirFromChangedFiles(['packages/simulator/package.json'])).toBe(
      'simulator',
    );
  });

  it('ignores files that are not a workspace manifest', () => {
    expect(
      dirFromChangedFiles([
        'packages/cli/src/index.ts',
        'packages/cli/package.json',
        'package.json',
        'RELEASING.md',
      ]),
    ).toBe('cli');
  });

  it('tolerates trailing whitespace from the git diff', () => {
    expect(
      dirFromChangedFiles(['packages/builder/package.json  ', '', '  ']),
    ).toBe('builder');
  });

  it('refuses to guess when two packages were bumped', () => {
    expect(() =>
      dirFromChangedFiles([
        'packages/cli/package.json',
        'packages/builder/package.json',
      ]),
    ).toThrow(
      /found 2: packages\/cli\/package\.json, packages\/builder\/package\.json/,
    );
  });

  it('refuses when no package was bumped', () => {
    expect(() => dirFromChangedFiles(['README.md'])).toThrow(/found 0/);
  });

  it('does not treat a nested manifest as a workspace bump', () => {
    expect(() =>
      dirFromChangedFiles(['packages/cli/node_modules/x/package.json']),
    ).toThrow(/found 0/);
  });

  it('rejects a bump in a directory outside the release rotation', () => {
    expect(() =>
      dirFromChangedFiles(['packages/deployer/package.json']),
    ).toThrow(/unknown package directory: deployer/);
  });
});
