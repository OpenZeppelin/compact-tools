import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type BuilderOptions,
  type BuildStep,
  CompactBuilder,
} from '@openzeppelin/compact-builder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const builders = vi.hoisted(() => ({
  build: vi.fn(),
  made: [] as { options: BuilderOptions; steps: readonly BuildStep[] }[],
}));

// Wrap the real builder: record its options and steps, and stub `build`.
vi.mock('@openzeppelin/compact-builder', async () => {
  const actual = await vi.importActual<
    typeof import('@openzeppelin/compact-builder')
  >('@openzeppelin/compact-builder');
  class RecordingBuilder extends actual.CompactBuilder {
    constructor(options: BuilderOptions) {
      super(options);
      builders.made.push({ options, steps: this.getSteps() });
    }

    override build(): Promise<void> {
      return builders.build();
    }
  }
  return { ...actual, CompactBuilder: RecordingBuilder };
});

// Mock chalk to a passthrough.
vi.mock('chalk', () => ({
  default: {
    blue: (text: string) => text,
    red: (text: string, extra?: string) =>
      extra === undefined ? text : `${text} ${extra}`,
  },
}));

// Mock ora.
const mockSpinner = {
  info: vi.fn().mockReturnThis(),
  fail: vi.fn().mockReturnThis(),
  succeed: vi.fn().mockReturnThis(),
};
vi.mock('ora', () => ({
  default: vi.fn(() => mockSpinner),
}));

const mockExit = vi
  .spyOn(process, 'exit')
  .mockImplementation(() => undefined as never);

describe('runBuilder CLI', () => {
  let originalArgv: string[];
  let repo: string;

  beforeEach(() => {
    originalArgv = [...process.argv];
    process.argv = ['node', 'runBuilder.js'];

    vi.clearAllMocks();
    vi.resetModules();
    builders.made.length = 0;
    builders.build.mockResolvedValue(undefined);

    repo = mkdtempSync(join(tmpdir(), 'compact-cli-builder-'));
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.mocked(process.cwd).mockRestore();
    rmSync(repo, { recursive: true, force: true });
  });

  const writeConfig = (toml: string) =>
    writeFileSync(join(repo, 'compact.toml'), toml);

  describe('successful build', () => {
    it('should build with no arguments', async () => {
      await import('../src/runBuilder.ts');

      expect(mockSpinner.info).toHaveBeenCalled();
      expect(builders.made).toHaveLength(1);
      expect(builders.made[0].options).toMatchObject(
        CompactBuilder.parseArgs([]),
      );
      expect(builders.build).toHaveBeenCalledTimes(1);
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should pass argv through to parseArgs', async () => {
      const args = ['--watch', '--dir', 'token'];
      process.argv = ['node', 'runBuilder.js', ...args];

      await import('../src/runBuilder.ts');

      expect(builders.made[0].options).toMatchObject(
        CompactBuilder.parseArgs(args),
      );
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe('generated-file excludes', () => {
    it('should exclude generated mocks and fragments without a [mock] table', async () => {
      writeConfig('[lint]\n');

      await import('../src/runBuilder.ts');

      expect(builders.made[0].options.alwaysExclude).toEqual([
        '*/test/artifacts/*',
        '*.fragment.compact',
      ]);
    });

    it('should read test_dir from the [mock] table', async () => {
      writeConfig('[mock]\ntest_dir = "{dir}/test/unit"\n');

      await import('../src/runBuilder.ts');

      expect(builders.made[0].options.alwaysExclude).toEqual([
        '*/test/unit/artifacts/*',
        '*.fragment.compact',
      ]);
    });

    it('should keep the default Mock* exclude in the dist copy', async () => {
      writeConfig('[mock]\n');

      await import('../src/runBuilder.ts');

      const { options, steps } = builders.made[0];
      expect(options.exclude).toBeUndefined();
      expect(
        steps.find((s) => s.msg === 'Copying .compact files')?.cmd,
      ).toContain(
        "! -name 'Mock*' ! -name '*.mock.compact' ! -path '*/test/artifacts/*' ! -name '*.fragment.compact'",
      );
    });

    it('should fail on a compact.toml it cannot parse', async () => {
      writeConfig('[mock\n');

      await import('../src/runBuilder.ts');

      expect(mockSpinner.fail).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[BUILD\] Unexpected error: cannot parse .*compact\.toml: /,
        ),
      );
      expect(builders.build).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('error handling', () => {
    it('should fail the spinner and exit 1 on build failure', async () => {
      builders.build.mockRejectedValue(new Error('Build broke'));

      await import('../src/runBuilder.ts');

      expect(mockSpinner.fail).toHaveBeenCalledWith(
        '[BUILD] Unexpected error: Build broke',
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should exit 1 on argument parsing failure', async () => {
      process.argv = ['node', 'runBuilder.js', '--copy'];

      await import('../src/runBuilder.ts');

      expect(mockSpinner.fail).toHaveBeenCalledWith(
        '[BUILD] Unexpected error: --copy flag requires a path',
      );
      expect(builders.build).not.toHaveBeenCalled();
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
