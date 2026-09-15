import { describe, expect, it } from 'vitest';
import { CompactBuilder } from '../src/Builder.js';

describe('CompactBuilder.parseArgs', () => {
  it('returns defaults for empty input', () => {
    const options = CompactBuilder.parseArgs([]);

    expect(options.cleanDist).toBeUndefined();
    expect(options.exclude).toBeUndefined();
    expect(options.copyToDist).toBeUndefined();
    // Compiler-side defaults still apply
    expect(options.hierarchical).toBe(false);
    expect(options.flags).toBe('');
  });

  it('parses --clean-dist', () => {
    expect(CompactBuilder.parseArgs(['--clean-dist']).cleanDist).toBe(true);
  });

  it('forwards --hierarchical to the compiler parser', () => {
    // `hierarchical` is parsed by CompactCompiler.parseArgs and drives both
    // compiler artifacts layout and builder .compact copy layout.
    expect(CompactBuilder.parseArgs(['--hierarchical']).hierarchical).toBe(
      true,
    );
  });

  it('accumulates repeated --exclude patterns', () => {
    const options = CompactBuilder.parseArgs([
      '--exclude',
      'Mock*',
      '--exclude',
      '*/archive/*',
    ]);

    expect(options.exclude).toEqual(['Mock*', '*/archive/*']);
  });

  it('accumulates repeated --copy paths', () => {
    const options = CompactBuilder.parseArgs([
      '--copy',
      'package.json',
      '--copy',
      '../README.md',
    ]);

    expect(options.copyToDist).toEqual(['package.json', '../README.md']);
  });

  it('forwards repeated --only patterns to the compiler parser', () => {
    const options = CompactBuilder.parseArgs([
      '--only',
      'MockEcdsa.compact',
      '--only',
      '*/mocks/*',
    ]);

    expect(options.only).toEqual(['MockEcdsa.compact', '*/mocks/*']);
  });

  it('throws when --exclude is missing a pattern', () => {
    expect(() => CompactBuilder.parseArgs(['--exclude'])).toThrow(
      '--exclude flag requires a pattern',
    );
    expect(() =>
      CompactBuilder.parseArgs(['--exclude', '--clean-dist']),
    ).toThrow('--exclude flag requires a pattern');
  });

  it('throws when --copy is missing a path', () => {
    expect(() => CompactBuilder.parseArgs(['--copy'])).toThrow(
      '--copy flag requires a path',
    );
    expect(() => CompactBuilder.parseArgs(['--copy', '--clean-dist'])).toThrow(
      '--copy flag requires a path',
    );
  });

  it('forwards unknown args to the compiler parser', () => {
    const options = CompactBuilder.parseArgs([
      '--dir',
      'security',
      '--skip-zk',
      '+0.29.0',
    ]);

    expect(options.targetDir).toBe('security');
    expect(options.flags).toBe('--skip-zk');
    expect(options.version).toBe('0.29.0');
  });

  it('combines builder and compiler flags', () => {
    const options = CompactBuilder.parseArgs([
      '--clean-dist',
      '--dir',
      'token',
      '--hierarchical',
      '--exclude',
      'Mock*',
      '--copy',
      'package.json',
      '--src',
      'contracts',
      '+0.29.0',
    ]);

    expect(options.cleanDist).toBe(true);
    expect(options.hierarchical).toBe(true);
    expect(options.exclude).toEqual(['Mock*']);
    expect(options.copyToDist).toEqual(['package.json']);
    expect(options.targetDir).toBe('token');
    expect(options.srcDir).toBe('contracts');
    expect(options.version).toBe('0.29.0');
  });
});

describe('CompactBuilder step pipeline', () => {
  it('uses the legacy 3-step pipeline by default', () => {
    const builder = new CompactBuilder();
    const steps = builder.getSteps();

    expect(steps.map((s) => s.msg)).toEqual([
      'Compiling TypeScript',
      'Copying artifacts',
      'Removing witness directories from dist',
      'Copying .compact files',
    ]);
  });

  it('excludes Mock* and *.mock.compact by default in the flat copy step', () => {
    const builder = new CompactBuilder();
    const copyStep = builder
      .getSteps()
      .find((s) => s.msg === 'Copying .compact files');

    expect(copyStep?.cmd).toContain("! -name 'Mock*'");
    expect(copyStep?.cmd).toContain("! -name '*.mock.compact'");
  });

  it('prepends a clean-dist step when cleanDist is true', () => {
    const builder = new CompactBuilder({ cleanDist: true });
    const steps = builder.getSteps();

    expect(steps[0].msg).toBe('Cleaning dist directory');
    expect(steps[0].cmd).toBe('rm -rf dist && mkdir -p dist');
    expect(steps).toHaveLength(5);
  });

  it('uses the hierarchical copy step when hierarchical is true', () => {
    const builder = new CompactBuilder({ hierarchical: true });
    const copyStep = builder
      .getSteps()
      .find((s) => s.msg === 'Copying .compact files (preserving structure)');

    expect(copyStep).toBeDefined();
    expect(copyStep?.cmd).toContain('rel_path=');
    expect(copyStep?.cmd).toContain('mkdir -p "dist/$(dirname "$rel_path")"');
  });

  it('appends a copy-to-dist step for each entry in copyToDist', () => {
    const builder = new CompactBuilder({
      copyToDist: ['package.json', '../README.md'],
    });
    const lastStep = builder.getSteps().at(-1);

    expect(lastStep?.msg).toBe('Copying additional files to dist');
    expect(lastStep?.cmd).toContain("cp 'package.json' dist/");
    expect(lastStep?.cmd).toContain("cp '../README.md' dist/");
  });

  it('removes witness directories after copying artifacts', () => {
    const builder = new CompactBuilder();
    const steps = builder.getSteps();
    const witnessStep = steps.find(
      (s) => s.msg === 'Removing witness directories from dist',
    );

    expect(witnessStep).toBeDefined();
    expect(witnessStep?.cmd).toBe(
      'find dist -type d -name "witnesses" -exec rm -rf {} +',
    );
  });

  it('runs witness removal after artifact copy and before .compact copy', () => {
    const builder = new CompactBuilder();
    const msgs = builder.getSteps().map((s) => s.msg);
    const artifactIdx = msgs.indexOf('Copying artifacts');
    const witnessIdx = msgs.indexOf('Removing witness directories from dist');
    const compactIdx = msgs.indexOf('Copying .compact files');

    expect(witnessIdx).toBe(artifactIdx + 1);
    expect(witnessIdx).toBeLessThan(compactIdx);
  });

  it('classifies excludes into -name and -path', () => {
    const builder = new CompactBuilder({
      hierarchical: true,
      exclude: ['Mock*', '*/archive/*'],
    });
    const copyStep = builder
      .getSteps()
      .find((s) => s.msg === 'Copying .compact files (preserving structure)');

    expect(copyStep?.cmd).toContain("! -name 'Mock*'");
    expect(copyStep?.cmd).toContain("! -path '*/archive/*'");
  });

  it('groups includes into an OR-ed find test', () => {
    const builder = new CompactBuilder({
      only: ['MockEcdsa.compact', '*/mocks/*'],
    });
    const copyStep = builder
      .getSteps()
      .find((s) => s.msg === 'Copying .compact files');

    expect(copyStep?.cmd).toContain(
      "\\( -name 'MockEcdsa.compact' -o -path '*/mocks/*' \\)",
    );
  });

  it('drops the default Mock* exclude when an include list is given', () => {
    const builder = new CompactBuilder({ only: ['Mock*'] });
    const copyStep = builder
      .getSteps()
      .find((s) => s.msg === 'Copying .compact files');

    expect(copyStep?.cmd).toContain("\\( -name 'Mock*' \\)");
    expect(copyStep?.cmd).not.toContain('! -name');
  });

  it('applies an explicit exclude on top of the include list', () => {
    const builder = new CompactBuilder({
      only: ['Mock*'],
      exclude: ['MockElGamal.compact'],
    });
    const copyStep = builder
      .getSteps()
      .find((s) => s.msg === 'Copying .compact files');

    expect(copyStep?.cmd).toContain("\\( -name 'Mock*' \\)");
    expect(copyStep?.cmd).toContain("! -name 'MockElGamal.compact'");
  });

  it('filters the hierarchical copy step by the include list', () => {
    const builder = new CompactBuilder({
      hierarchical: true,
      only: ['*/mocks/*'],
    });
    const copyStep = builder
      .getSteps()
      .find((s) => s.msg === 'Copying .compact files (preserving structure)');

    expect(copyStep?.cmd).toContain("\\( -path '*/mocks/*' \\)");
  });

  it('honours an explicit empty exclude list (disables the default Mock*)', () => {
    const builder = new CompactBuilder({ exclude: [] });
    const copyStep = builder
      .getSteps()
      .find((s) => s.msg === 'Copying .compact files');

    expect(copyStep?.cmd).not.toContain('! -name');
  });

  it('shell-quotes srcDir into find paths', () => {
    const builder = new CompactBuilder({ srcDir: 'my src' });
    const copyStep = builder
      .getSteps()
      .find((s) => s.msg === 'Copying .compact files');

    expect(copyStep?.cmd).toContain("find 'my src'");
  });

  it('produces the full pipeline for a library-publish configuration', () => {
    const builder = new CompactBuilder({
      cleanDist: true,
      hierarchical: true,
      exclude: ['Mock*', '*/archive/*'],
      copyToDist: ['package.json', '../README.md'],
    });

    expect(builder.getSteps().map((s) => s.msg)).toEqual([
      'Cleaning dist directory',
      'Compiling TypeScript',
      'Copying artifacts',
      'Removing witness directories from dist',
      'Copying .compact files (preserving structure)',
      'Copying additional files to dist',
    ]);
  });
});
