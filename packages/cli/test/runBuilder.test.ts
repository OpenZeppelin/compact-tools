import { CompactBuilder } from '@openzeppelin/compact-builder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the library so we can drive the CLI in isolation.
vi.mock('@openzeppelin/compact-builder', async () => {
  const actual = await vi.importActual<
    typeof import('@openzeppelin/compact-builder')
  >('@openzeppelin/compact-builder');
  return {
    ...actual,
    CompactBuilder: {
      fromArgs: vi.fn(),
    },
  };
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
  let mockBuild: ReturnType<typeof vi.fn>;
  let mockFromArgs: ReturnType<typeof vi.fn>;
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];

    vi.clearAllMocks();
    vi.resetModules();

    mockBuild = vi.fn();
    mockFromArgs = vi.mocked(CompactBuilder.fromArgs);
    mockFromArgs.mockReturnValue({ build: mockBuild } as any);

    mockSpinner.info.mockClear();
    mockSpinner.fail.mockClear();
    mockSpinner.succeed.mockClear();
    mockExit.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  describe('successful build', () => {
    it('should build with no arguments', async () => {
      process.argv = ['node', 'runBuilder.js'];
      mockBuild.mockResolvedValue(undefined);

      await import('../src/runBuilder.ts');

      expect(mockSpinner.info).toHaveBeenCalled();
      expect(mockFromArgs).toHaveBeenCalledWith([]);
      expect(mockBuild).toHaveBeenCalledTimes(1);
      expect(mockExit).not.toHaveBeenCalled();
    });

    it('should pass argv through to fromArgs', async () => {
      const args = ['--watch', '--dir', 'token'];
      process.argv = ['node', 'runBuilder.js', ...args];
      mockBuild.mockResolvedValue(undefined);

      await import('../src/runBuilder.ts');

      expect(mockFromArgs).toHaveBeenCalledWith(args);
      expect(mockExit).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should fail the spinner and exit 1 on build failure', async () => {
      const error = new Error('Build broke');
      mockBuild.mockRejectedValue(error);

      await import('../src/runBuilder.ts');

      expect(mockSpinner.fail).toHaveBeenCalledWith(
        '[BUILD] Unexpected error: Build broke',
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should exit 1 on argument parsing failure', async () => {
      mockFromArgs.mockImplementation(() => {
        throw new Error('bad flag');
      });

      await import('../src/runBuilder.ts');

      expect(mockSpinner.fail).toHaveBeenCalledWith(
        '[BUILD] Unexpected error: bad flag',
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });
});
