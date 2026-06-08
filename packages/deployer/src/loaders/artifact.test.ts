import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactNotFoundError, ConfigError } from '../errors.ts';

vi.mock('@midnight-ntwrk/compact-js', () => ({
  CompiledContract: {
    make: vi.fn((name: string, Ctor: unknown) => ({ name, Ctor })),
    withWitnesses: vi.fn((base: unknown, w: unknown) => ({
      ...(base as object),
      w,
    })),
    withVacantWitnesses: vi.fn((base: unknown) => ({
      ...(base as object),
      vacant: true,
    })),
    withCompiledFileAssets: vi.fn((c: unknown, dir: string) => ({
      ...(c as object),
      contractDir: dir,
    })),
  },
}));

const { Artifact } = await import('./artifact.ts');

function makeArtifactDir(
  root: string,
  name: string,
  opts: {
    contractEntry?: 'cjs' | 'js' | 'top-level-cjs' | 'top-level-js' | 'none';
    keys?: boolean;
    zkir?: boolean;
    circuits?: string[];
    contractExport?: 'named' | 'default' | 'none';
  } = {},
): string {
  const {
    contractEntry = 'cjs',
    keys = true,
    zkir = true,
    circuits = ['inc', 'dec'],
    contractExport = 'named',
  } = opts;

  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });

  if (contractEntry !== 'none') {
    const isTopLevel = contractEntry.startsWith('top-level');
    const ext = contractEntry.endsWith('cjs') ? 'cjs' : 'js';
    const subDir = isTopLevel ? dir : join(dir, 'contract');
    mkdirSync(subDir, { recursive: true });

    let body = '';
    if (contractExport === 'named') {
      body = 'module.exports.Contract = function Counter() {};';
    } else if (contractExport === 'default') {
      body = 'module.exports.default = { Contract: function Counter() {} };';
    } else {
      body = 'module.exports.somethingElse = 1;';
    }
    writeFileSync(join(subDir, `index.${ext}`), body);
  }

  if (keys) mkdirSync(join(dir, 'keys'), { recursive: true });

  if (zkir) {
    mkdirSync(join(dir, 'zkir'), { recursive: true });
    for (const c of circuits) {
      writeFileSync(join(dir, 'zkir', `${c}.bzkir`), '');
    }
  }

  return dir;
}

describe('Artifact.load — path resolution', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-test-'));
  });

  it('should resolve a relative artifact under rootDir directly', async () => {
    makeArtifactDir(root, 'Counter');
    const art = await Artifact.load({
      rootDir: root,
      artifactsDir: 'unused/',
      artifact: 'Counter',
      contractName: 'Counter',
    });
    expect(art.artifactPath).toBe(join(root, 'Counter'));
  });

  it('should fall back to artifactsDir when the direct path is missing', async () => {
    const artifactsRel = 'build/out';
    makeArtifactDir(join(root, artifactsRel), 'Counter');
    const art = await Artifact.load({
      rootDir: root,
      artifactsDir: artifactsRel,
      artifact: 'Counter',
      contractName: 'Counter',
    });
    expect(art.artifactPath).toBe(join(root, artifactsRel, 'Counter'));
  });

  it('should treat an absolute artifact path as-is', async () => {
    const abs = makeArtifactDir(root, 'AbsCounter');
    const art = await Artifact.load({
      rootDir: '/elsewhere',
      artifactsDir: 'unused/',
      artifact: abs,
      contractName: 'AbsCounter',
    });
    expect(art.artifactPath).toBe(abs);
  });
});

describe('Artifact.load — error paths', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-err-'));
  });

  it('should throw ArtifactNotFoundError when the directory is missing', async () => {
    await expect(
      Artifact.load({
        rootDir: root,
        artifactsDir: 'src/artifacts',
        artifact: 'NopeMissing',
        contractName: 'NopeMissing',
      }),
    ).rejects.toThrow(ArtifactNotFoundError);
  });

  it('should throw ArtifactNotFoundError when contract/index entry is missing', async () => {
    makeArtifactDir(root, 'NoEntry', { contractEntry: 'none' });
    await expect(
      Artifact.load({
        rootDir: root,
        artifactsDir: 'src/artifacts',
        artifact: 'NoEntry',
        contractName: 'NoEntry',
      }),
    ).rejects.toThrow(/no contract\/index/);
  });

  it('should throw ArtifactNotFoundError when keys/ is missing', async () => {
    makeArtifactDir(root, 'NoKeys', { keys: false });
    await expect(
      Artifact.load({
        rootDir: root,
        artifactsDir: 'src/artifacts',
        artifact: 'NoKeys',
        contractName: 'NoKeys',
      }),
    ).rejects.toThrow(/missing keys\/ or zkir\//);
  });

  it('should throw ArtifactNotFoundError when zkir/ is missing', async () => {
    makeArtifactDir(root, 'NoZkir', { zkir: false });
    await expect(
      Artifact.load({
        rootDir: root,
        artifactsDir: 'src/artifacts',
        artifact: 'NoZkir',
        contractName: 'NoZkir',
      }),
    ).rejects.toThrow(/missing keys\/ or zkir\//);
  });

  it('should throw ConfigError when index does not export a Contract class', async () => {
    makeArtifactDir(root, 'NoExport', { contractExport: 'none' });
    await expect(
      Artifact.load({
        rootDir: root,
        artifactsDir: 'src/artifacts',
        artifact: 'NoExport',
        contractName: 'NoExport',
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('should throw ConfigError when witnesses ref is a file ref (functions only via module)', async () => {
    makeArtifactDir(root, 'WitnessFile');
    await expect(
      Artifact.load({
        rootDir: root,
        artifactsDir: 'src/artifacts',
        artifact: 'WitnessFile',
        contractName: 'WitnessFile',
        witnesses: { file: 'w.json' },
      }),
    ).rejects.toThrow(
      /witnesses.*module.*export.*JSON file refs are not supported/,
    );
  });

  it('should throw ConfigError when witnesses module export does not resolve to an object', async () => {
    makeArtifactDir(root, 'WitnessNonObject');
    writeFileSync(
      join(root, 'w.mjs'),
      'export const witnesses = "not-an-object";',
    );
    await expect(
      Artifact.load({
        rootDir: root,
        artifactsDir: 'src/artifacts',
        artifact: 'WitnessNonObject',
        contractName: 'WitnessNonObject',
        witnesses: { module: 'w.mjs', export: 'witnesses' },
      }),
    ).rejects.toThrow(/must resolve to an object/);
  });
});

describe('Artifact.load — witnesses module ref', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-wit-'));
  });

  it('should accept a { module, export } witnesses ref that resolves to an object', async () => {
    makeArtifactDir(root, 'WithWitnesses');
    writeFileSync(
      join(root, 'w.mjs'),
      'export const witnesses = { add: () => 1 };',
    );
    const art = await Artifact.load({
      rootDir: root,
      artifactsDir: 'src/artifacts',
      artifact: 'WithWitnesses',
      contractName: 'WithWitnesses',
      witnesses: { module: 'w.mjs', export: 'witnesses' },
    });
    expect(art.artifactPath).toBe(join(root, 'WithWitnesses'));
  });
});

describe('Artifact.load — entry-file fallbacks', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-entry-'));
  });

  it('should accept contract/index.js when contract/index.cjs is missing', async () => {
    makeArtifactDir(root, 'CounterJs', { contractEntry: 'js' });
    const art = await Artifact.load({
      rootDir: root,
      artifactsDir: 'unused/',
      artifact: 'CounterJs',
      contractName: 'CounterJs',
    });
    expect(art.artifactPath).toBe(join(root, 'CounterJs'));
  });

  it('should fall back to top-level index.cjs when contract/ has no entry', async () => {
    makeArtifactDir(root, 'TopLevel', { contractEntry: 'top-level-cjs' });
    const art = await Artifact.load({
      rootDir: root,
      artifactsDir: 'unused/',
      artifact: 'TopLevel',
      contractName: 'TopLevel',
    });
    expect(art.artifactPath).toBe(join(root, 'TopLevel'));
  });
});

describe('Artifact.load — circuit collection', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-circuits-'));
  });

  it('should collect and sort circuit names from .bzkir files', async () => {
    makeArtifactDir(root, 'C', { circuits: ['zeta', 'alpha', 'mu'] });
    const art = await Artifact.load({
      rootDir: root,
      artifactsDir: 'unused/',
      artifact: 'C',
      contractName: 'C',
    });
    expect(art.circuitNames).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('should produce an empty circuit list when zkir/ has no .bzkir files', async () => {
    makeArtifactDir(root, 'Empty', { circuits: [] });
    const art = await Artifact.load({
      rootDir: root,
      artifactsDir: 'unused/',
      artifact: 'Empty',
      contractName: 'Empty',
    });
    expect(art.circuitNames).toEqual([]);
  });
});

describe('Artifact.load — default export Contract', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'artifact-default-'));
  });

  it('should pick Contract from module.default when not on the top namespace', async () => {
    makeArtifactDir(root, 'Default', { contractExport: 'default' });
    const art = await Artifact.load({
      rootDir: root,
      artifactsDir: 'unused/',
      artifact: 'Default',
      contractName: 'Default',
    });
    expect(art.artifactPath).toBe(join(root, 'Default'));
  });
});
