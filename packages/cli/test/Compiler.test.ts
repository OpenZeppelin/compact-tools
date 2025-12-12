import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import {
  beforeEach,
  describe,
  expect,
  it,
  type MockedFunction,
  vi,
} from 'vitest';
import { CompactCompiler } from '../src/Compiler.js';
import {
  CompilerService,
  parseCircuitInfo,
  parseContractMetadata,
} from '../src/services/CompilerService.js';
import {
  EnvironmentValidator,
  type ExecFunction,
} from '../src/services/EnvironmentValidator.js';
import { FileDiscovery } from '../src/services/FileDiscovery.js';
import { ManifestService } from '../src/services/ManifestService.js';
import { UIService } from '../src/services/UIService.js';
import {
  CompactCliNotFoundError,
  CompilationError,
  DirectoryNotFoundError,
} from '../src/types/errors.js';
import {
  MANIFEST_FILENAME,
  StructureMismatchError,
} from '../src/types/manifest.js';

// Mock Node.js modules
vi.mock('node:fs');
vi.mock('node:fs/promises');
vi.mock('chalk', () => ({
  default: {
    blue: (text: string) => text,
    green: (text: string) => text,
    red: (text: string) => text,
    yellow: (text: string) => text,
    cyan: (text: string) => text,
    gray: (text: string) => text,
  },
}));

// Mock spinner
const mockSpinner = {
  start: () => ({
    succeed: vi.fn(),
    fail: vi.fn(),
    stopAndPersist: vi.fn(),
    text: '',
  }),
  info: vi.fn(),
  warn: vi.fn(),
  fail: vi.fn(),
  succeed: vi.fn(),
  stopAndPersist: vi.fn(),
};

vi.mock('ora', () => ({
  default: () => mockSpinner,
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockRm = vi.mocked(rm);

describe('EnvironmentValidator', () => {
  let mockExec: MockedFunction<ExecFunction>;
  let validator: EnvironmentValidator;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec = vi.fn();
    validator = new EnvironmentValidator(mockExec);
  });

  describe('checkCompactAvailable', () => {
    it('should return true when compact CLI is available', async () => {
      mockExec.mockResolvedValue({ stdout: 'compact 0.1.0', stderr: '' });

      const result = await validator.checkCompactAvailable();

      expect(result).toBe(true);
      expect(mockExec).toHaveBeenCalledWith('compact --version');
    });

    it('should return false when compact CLI is not available', async () => {
      mockExec.mockRejectedValue(new Error('Command not found'));

      const result = await validator.checkCompactAvailable();

      expect(result).toBe(false);
      expect(mockExec).toHaveBeenCalledWith('compact --version');
    });
  });

  describe('getCompactToolVersion', () => {
    it('should return trimmed version string', async () => {
      mockExec.mockResolvedValue({ stdout: '  0.3.0  \n', stderr: '' });

      const version = await validator.getCompactToolVersion();

      expect(version).toBe('0.3.0');
      expect(mockExec).toHaveBeenCalledWith('compact --version');
    });

    it('should throw error when command fails', async () => {
      mockExec.mockRejectedValue(new Error('Command failed'));

      await expect(validator.getCompactToolVersion()).rejects.toThrow(
        'Command failed',
      );
    });
  });

  describe('getCompactcVersion', () => {
    it('should get version without specific version flag', async () => {
      mockExec.mockResolvedValue({
        stdout: '0.26.0',
        stderr: '',
      });

      const version = await validator.getCompactcVersion();

      expect(version).toBe('0.26.0');
      expect(mockExec).toHaveBeenCalledWith('compact compile  --version');
    });

    it('should get version with specific version flag', async () => {
      mockExec.mockResolvedValue({
        stdout: '0.26.0',
        stderr: '',
      });

      const version = await validator.getCompactcVersion('0.26.0');

      expect(version).toBe('0.26.0');
      expect(mockExec).toHaveBeenCalledWith(
        'compact compile +0.26.0 --version',
      );
    });
  });

  describe('validate', () => {
    it('should validate successfully when CLI is available', async () => {
      mockExec.mockResolvedValue({ stdout: 'compact 0.1.0', stderr: '' });

      await expect(validator.validate()).resolves.not.toThrow();
    });

    it('should throw CompactCliNotFoundError when CLI is not available', async () => {
      mockExec.mockRejectedValue(new Error('Command not found'));

      await expect(validator.validate()).rejects.toThrow(
        CompactCliNotFoundError,
      );
    });
  });
});

describe('FileDiscovery', () => {
  let discovery: FileDiscovery;

  beforeEach(() => {
    vi.clearAllMocks();
    discovery = new FileDiscovery();
  });

  describe('getCompactFiles', () => {
    it('should find .compact files in directory', async () => {
      const mockDirents = [
        {
          name: 'MyToken.compact',
          isFile: () => true,
          isDirectory: () => false,
        },
        {
          name: 'Ownable.compact',
          isFile: () => true,
          isDirectory: () => false,
        },
        { name: 'README.md', isFile: () => true, isDirectory: () => false },
        { name: 'utils', isFile: () => false, isDirectory: () => true },
      ];

      mockReaddir
        .mockResolvedValueOnce(mockDirents as any)
        .mockResolvedValueOnce([
          {
            name: 'Utils.compact',
            isFile: () => true,
            isDirectory: () => false,
          },
        ] as any);

      const files = await discovery.getCompactFiles('src');

      expect(files).toEqual([
        'MyToken.compact',
        'Ownable.compact',
        'utils/Utils.compact',
      ]);
    });

    it('should handle empty directories', async () => {
      mockReaddir.mockResolvedValue([]);

      const files = await discovery.getCompactFiles('src');

      expect(files).toEqual([]);
    });

    it('should handle directory read errors gracefully', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      mockReaddir.mockRejectedValueOnce(new Error('Permission denied'));

      const files = await discovery.getCompactFiles('src');

      expect(files).toEqual([]);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to read dir: src',
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });

    it('should handle file access errors gracefully', async () => {
      const mockDirents = [
        {
          name: 'MyToken.compact',
          isFile: () => {
            throw new Error('Access denied');
          },
          isDirectory: () => false,
        },
        {
          name: 'Ownable.compact',
          isFile: () => true,
          isDirectory: () => false,
        },
      ];

      mockReaddir.mockResolvedValue(mockDirents as any);

      const files = await discovery.getCompactFiles('src');

      expect(files).toEqual(['Ownable.compact']);
    });
  });
});

describe('CompilerService', () => {
  let mockExec: MockedFunction<ExecFunction>;
  let service: CompilerService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec = vi.fn();
    service = new CompilerService(mockExec);
  });

  describe('compileFile', () => {
    it('should compile file successfully with basic flags', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Compilation successful',
        stderr: '',
      });

      const result = await service.compileFile('MyToken.compact', [
        '--skip-zk',
      ]);

      expect(result.stdout).toBe('Compilation successful');
      expect(result.stderr).toBe('');
      expect(result.metadata).toEqual({ type: 'module' });
      // Check core command parts (quotes may be escaped differently on Linux due to script wrapper)
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile --skip-zk'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('src/MyToken.compact'),
      );
    });

    it('should compile file with version flag', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Compilation successful',
        stderr: '',
      });

      const result = await service.compileFile(
        'MyToken.compact',
        ['--skip-zk'],
        '0.26.0',
      );

      expect(result.stdout).toBe('Compilation successful');
      expect(result.stderr).toBe('');
      expect(result.metadata.type).toBe('module');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile +0.26.0 --skip-zk'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('src/MyToken.compact'),
      );
    });

    it('should handle empty flags', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Compilation successful',
        stderr: '',
      });

      const result = await service.compileFile('MyToken.compact', []);

      expect(result.stdout).toBe('Compilation successful');
      expect(result.stderr).toBe('');
      expect(result.metadata.type).toBe('module');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('src/MyToken.compact'),
      );
    });

    it('should use flattened artifacts output by default', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Compilation successful',
        stderr: '',
      });

      const result = await service.compileFile('access/AccessControl.compact', [
        '--skip-zk',
      ]);

      expect(result.stdout).toBe('Compilation successful');
      expect(result.stderr).toBe('');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile --skip-zk'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('src/access/AccessControl.compact'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('artifacts/AccessControl'),
      );
    });

    it('should flatten nested directory structure by default', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Compilation successful',
        stderr: '',
      });

      const result = await service.compileFile(
        'access/test/AccessControl.mock.compact',
        ['--skip-zk'],
      );

      expect(result.stdout).toBe('Compilation successful');
      expect(result.stderr).toBe('');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile --skip-zk'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('src/access/test/AccessControl.mock.compact'),
      );
    });

    it('should parse circuit info and return top-level metadata', async () => {
      const circuitOutput = `Compiling 4 circuits:
  circuit "gt" (k=12, rows=2639)  
  circuit "gte" (k=12, rows=2643)  
  circuit "lt" (k=12, rows=2639)  
  circuit "lte" (k=12, rows=2643)  
Overall progress [====================] 4/4`;

      mockExec.mockResolvedValue({
        stdout: 'compactc 0.26.0',
        stderr: circuitOutput,
      });

      const result = await service.compileFile('Bytes32.mock.compact', []);

      expect(result.metadata.type).toBe('top-level');
      expect(result.metadata.circuits).toHaveLength(4);
      expect(result.metadata.circuits).toEqual([
        { name: 'gt', k: 12, rows: 2639 },
        { name: 'gte', k: 12, rows: 2643 },
        { name: 'lt', k: 12, rows: 2639 },
        { name: 'lte', k: 12, rows: 2643 },
      ]);
    });

    it('should throw CompilationError when compilation fails', async () => {
      mockExec.mockRejectedValue(new Error('Syntax error on line 10'));

      await expect(
        service.compileFile('MyToken.compact', ['--skip-zk']),
      ).rejects.toThrow(CompilationError);
    });

    it('should include file path in CompilationError', async () => {
      mockExec.mockRejectedValue(new Error('Syntax error'));

      try {
        await service.compileFile('MyToken.compact', ['--skip-zk']);
      } catch (error) {
        expect(error).toBeInstanceOf(CompilationError);
        expect((error as CompilationError).file).toBe('MyToken.compact');
      }
    });

    it('should include cause in CompilationError', async () => {
      const mockError = new Error('Syntax error');
      mockExec.mockRejectedValue(mockError);

      try {
        await service.compileFile('MyToken.compact', ['--skip-zk']);
      } catch (error) {
        expect(error).toBeInstanceOf(CompilationError);
        expect((error as CompilationError).cause).toEqual(mockError);
      }
    });
  });

  describe('compileFile with hierarchical option', () => {
    beforeEach(() => {
      service = new CompilerService(mockExec, { hierarchical: true });
    });

    it('should preserve directory structure in artifacts output when hierarchical is true', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Compilation successful',
        stderr: '',
      });

      const result = await service.compileFile('access/AccessControl.compact', [
        '--skip-zk',
      ]);

      expect(result.stdout).toBe('Compilation successful');
      expect(result.stderr).toBe('');
      expect(result.metadata.type).toBe('module');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile --skip-zk'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('src/access/AccessControl.compact'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('artifacts/access/AccessControl'),
      );
    });

    it('should preserve nested directory structure when hierarchical is true', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Compilation successful',
        stderr: '',
      });

      const result = await service.compileFile(
        'access/test/AccessControl.mock.compact',
        ['--skip-zk'],
      );

      expect(result.stdout).toBe('Compilation successful');
      expect(result.stderr).toBe('');
      expect(result.metadata.type).toBe('module');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile --skip-zk'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('src/access/test/AccessControl.mock.compact'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('artifacts/access/test/AccessControl.mock'),
      );
    });

    it('should use flattened output for root-level files even when hierarchical is true', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Compilation successful',
        stderr: '',
      });

      const result = await service.compileFile('MyToken.compact', [
        '--skip-zk',
      ]);

      expect(result.stdout).toBe('Compilation successful');
      expect(result.stderr).toBe('');
      expect(result.metadata.type).toBe('module');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile --skip-zk'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('src/MyToken.compact'),
      );
    });
  });

  describe('compileFile with custom srcDir and outDir', () => {
    beforeEach(() => {
      service = new CompilerService(mockExec, {
        srcDir: 'contracts',
        outDir: 'build',
      });
    });

    it('should use custom srcDir and outDir', async () => {
      mockExec.mockResolvedValue({
        stdout: 'Compilation successful',
        stderr: '',
      });

      const result = await service.compileFile('MyToken.compact', [
        '--skip-zk',
      ]);

      expect(result.stdout).toBe('Compilation successful');
      expect(result.stderr).toBe('');
      expect(result.metadata.type).toBe('module');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile --skip-zk'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('contracts/MyToken.compact'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('build/MyToken'),
      );
    });

    it('should use custom directories with hierarchical option', async () => {
      service = new CompilerService(mockExec, {
        srcDir: 'contracts',
        outDir: 'dist/artifacts',
        hierarchical: true,
      });
      mockExec.mockResolvedValue({
        stdout: 'Compilation successful',
        stderr: '',
      });

      const result = await service.compileFile('access/AccessControl.compact', [
        '--skip-zk',
      ]);

      expect(result.stdout).toBe('Compilation successful');
      expect(result.stderr).toBe('');
      expect(result.metadata.type).toBe('module');
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile --skip-zk'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('contracts/access/AccessControl.compact'),
      );
      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('dist/artifacts/access/AccessControl'),
      );
    });
  });
});

describe('parseCircuitInfo', () => {
  it('should parse single circuit info', () => {
    const output = 'circuit "transfer" (k=14, rows=8192)';

    const circuits = parseCircuitInfo(output);

    expect(circuits).toEqual([{ name: 'transfer', k: 14, rows: 8192 }]);
  });

  it('should parse multiple circuits', () => {
    const output = `Compiling 4 circuits:
  circuit "gt" (k=12, rows=2639)  
  circuit "gte" (k=12, rows=2643)  
  circuit "lt" (k=12, rows=2639)  
  circuit "lte" (k=12, rows=2643)  
Overall progress [====================] 4/4`;

    const circuits = parseCircuitInfo(output);

    expect(circuits).toHaveLength(4);
    expect(circuits[0]).toEqual({ name: 'gt', k: 12, rows: 2639 });
    expect(circuits[1]).toEqual({ name: 'gte', k: 12, rows: 2643 });
    expect(circuits[2]).toEqual({ name: 'lt', k: 12, rows: 2639 });
    expect(circuits[3]).toEqual({ name: 'lte', k: 12, rows: 2643 });
  });

  it('should return empty array for module contracts (no circuits)', () => {
    const output = 'compactc 0.26.0\nCompilation successful';

    const circuits = parseCircuitInfo(output);

    expect(circuits).toEqual([]);
  });

  it('should handle circuits with different k and rows values', () => {
    const output = `circuit "small" (k=10, rows=512)
circuit "large" (k=20, rows=1048576)`;

    const circuits = parseCircuitInfo(output);

    expect(circuits).toEqual([
      { name: 'small', k: 10, rows: 512 },
      { name: 'large', k: 20, rows: 1048576 },
    ]);
  });

  it('should handle circuit names with special characters', () => {
    const output = 'circuit "verify_signature_v2" (k=15, rows=4096)';

    const circuits = parseCircuitInfo(output);

    expect(circuits).toEqual([
      { name: 'verify_signature_v2', k: 15, rows: 4096 },
    ]);
  });

  it('should be reentrant (handle multiple calls)', () => {
    const output1 = 'circuit "first" (k=10, rows=100)';
    const output2 = 'circuit "second" (k=11, rows=200)';

    const circuits1 = parseCircuitInfo(output1);
    const circuits2 = parseCircuitInfo(output2);

    expect(circuits1).toEqual([{ name: 'first', k: 10, rows: 100 }]);
    expect(circuits2).toEqual([{ name: 'second', k: 11, rows: 200 }]);
  });
});

describe('parseContractMetadata', () => {
  it('should return module type for contracts without circuits', () => {
    const output = 'compactc 0.26.0\nCompilation successful';

    const metadata = parseContractMetadata(output);

    expect(metadata).toEqual({ type: 'module' });
    expect(metadata.circuits).toBeUndefined();
  });

  it('should return top-level type with circuits for contracts with circuits', () => {
    const output = `Compiling 2 circuits:
  circuit "mint" (k=14, rows=5000)  
  circuit "burn" (k=14, rows=4800)  
Overall progress [====================] 2/2`;

    const metadata = parseContractMetadata(output);

    expect(metadata.type).toBe('top-level');
    expect(metadata.circuits).toHaveLength(2);
    expect(metadata.circuits).toEqual([
      { name: 'mint', k: 14, rows: 5000 },
      { name: 'burn', k: 14, rows: 4800 },
    ]);
  });

  it('should handle single circuit', () => {
    const output = 'circuit "init" (k=12, rows=1024)';

    const metadata = parseContractMetadata(output);

    expect(metadata.type).toBe('top-level');
    expect(metadata.circuits).toEqual([{ name: 'init', k: 12, rows: 1024 }]);
  });
});

describe('UIService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('printOutput', () => {
    it('should format output with indentation', () => {
      const mockColorFn = vi.fn((text: string) => `colored(${text})`);

      UIService.printOutput('line 1\nline 2\n\nline 3', mockColorFn);

      expect(mockColorFn).toHaveBeenCalledWith(
        '    line 1\n    line 2\n    line 3',
      );
      expect(console.log).toHaveBeenCalledWith(
        'colored(    line 1\n    line 2\n    line 3)',
      );
    });

    it('should handle empty output', () => {
      const mockColorFn = vi.fn((text: string) => `colored(${text})`);

      UIService.printOutput('', mockColorFn);

      expect(mockColorFn).toHaveBeenCalledWith('');
      expect(console.log).toHaveBeenCalledWith('colored()');
    });
  });

  describe('displayEnvInfo', () => {
    it('should display environment information with all parameters', () => {
      UIService.displayEnvInfo('0.3.0', '0.26.0', 'security', '0.26.0');

      expect(mockSpinner.info).toHaveBeenCalledWith(
        '[COMPILE] TARGET_DIR: security',
      );
      expect(mockSpinner.info).toHaveBeenCalledWith(
        '[COMPILE] compact-tools: 0.3.0',
      );
      expect(mockSpinner.info).toHaveBeenCalledWith(
        '[COMPILE] compactc: 0.26.0',
      );
      expect(mockSpinner.info).toHaveBeenCalledWith(
        '[COMPILE] Using compactc version: 0.26.0',
      );
    });

    it('should display environment information without optional parameters', () => {
      UIService.displayEnvInfo('0.3.0', '0.26.0');

      expect(mockSpinner.info).toHaveBeenCalledWith(
        '[COMPILE] compact-tools: 0.3.0',
      );
      expect(mockSpinner.info).toHaveBeenCalledWith(
        '[COMPILE] compactc: 0.26.0',
      );
      expect(mockSpinner.info).not.toHaveBeenCalledWith(
        expect.stringContaining('TARGET_DIR'),
      );
      expect(mockSpinner.info).not.toHaveBeenCalledWith(
        expect.stringContaining('Using compactc version'),
      );
    });
  });

  describe('showCompilationStart', () => {
    it('should show file count without target directory', () => {
      UIService.showCompilationStart(5);

      expect(mockSpinner.info).toHaveBeenCalledWith(
        '[COMPILE] Found 5 .compact file(s) to compile',
      );
    });

    it('should show file count with target directory', () => {
      UIService.showCompilationStart(3, 'security');

      expect(mockSpinner.info).toHaveBeenCalledWith(
        '[COMPILE] Found 3 .compact file(s) to compile in security/',
      );
    });
  });

  describe('showNoFiles', () => {
    it('should show no files message with target directory', () => {
      UIService.showNoFiles('security');

      expect(mockSpinner.warn).toHaveBeenCalledWith(
        '[COMPILE] No .compact files found in security/.',
      );
    });

    it('should show no files message without target directory', () => {
      UIService.showNoFiles();

      expect(mockSpinner.warn).toHaveBeenCalledWith(
        '[COMPILE] No .compact files found in .',
      );
    });
  });
});

describe('CompactCompiler', () => {
  let mockExec: MockedFunction<ExecFunction>;
  let compiler: CompactCompiler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec = vi.fn().mockResolvedValue({ stdout: 'success', stderr: '' });
    mockExistsSync.mockReturnValue(true);
    mockReaddir.mockResolvedValue([]);
  });

  describe('constructor', () => {
    it('should create instance with default parameters', () => {
      compiler = new CompactCompiler();

      expect(compiler).toBeInstanceOf(CompactCompiler);
      expect(compiler.testOptions.flags).toEqual([]);
      expect(compiler.testOptions.targetDir).toBeUndefined();
      expect(compiler.testOptions.version).toBeUndefined();
      expect(compiler.testOptions.hierarchical).toBe(false);
      expect(compiler.testOptions.srcDir).toBe('src');
      expect(compiler.testOptions.outDir).toBe('artifacts');
    });

    it('should create instance with all parameters', () => {
      compiler = new CompactCompiler(
        {
          flags: ['--skip-zk'],
          targetDir: 'security',
          version: '0.26.0',
          hierarchical: true,
          srcDir: 'contracts',
          outDir: 'build',
        },
        mockExec,
      );

      expect(compiler).toBeInstanceOf(CompactCompiler);
      expect(compiler.testOptions.flags).toEqual(['--skip-zk']);
      expect(compiler.testOptions.targetDir).toBe('security');
      expect(compiler.testOptions.version).toBe('0.26.0');
      expect(compiler.testOptions.hierarchical).toBe(true);
      expect(compiler.testOptions.srcDir).toBe('contracts');
      expect(compiler.testOptions.outDir).toBe('build');
    });

    it('should handle flags array', () => {
      compiler = new CompactCompiler({
        flags: ['--skip-zk', '--trace-passes'],
      });
      expect(compiler.testOptions.flags).toEqual([
        '--skip-zk',
        '--trace-passes',
      ]);
    });
  });

  describe('fromArgs', () => {
    it('should parse empty arguments', () => {
      compiler = CompactCompiler.fromArgs([]);

      expect(compiler.testOptions.flags).toEqual([]);
      expect(compiler.testOptions.targetDir).toBeUndefined();
      expect(compiler.testOptions.version).toBeUndefined();
      expect(compiler.testOptions.hierarchical).toBe(false);
    });

    it('should handle SKIP_ZK environment variable', () => {
      compiler = CompactCompiler.fromArgs([], { SKIP_ZK: 'true' });

      expect(compiler.testOptions.flags).toEqual(['--skip-zk']);
    });

    it('should ignore SKIP_ZK when not "true"', () => {
      compiler = CompactCompiler.fromArgs([], { SKIP_ZK: 'false' });

      expect(compiler.testOptions.flags).toEqual([]);
    });

    it('should parse --dir flag', () => {
      compiler = CompactCompiler.fromArgs(['--dir', 'security']);

      expect(compiler.testOptions.targetDir).toBe('security');
      expect(compiler.testOptions.flags).toEqual([]);
    });

    it('should parse --dir flag with additional flags', () => {
      compiler = CompactCompiler.fromArgs([
        '--dir',
        'security',
        '--skip-zk',
        '--trace-passes',
      ]);

      expect(compiler.testOptions.targetDir).toBe('security');
      expect(compiler.testOptions.flags).toEqual([
        '--skip-zk',
        '--trace-passes',
      ]);
    });

    it('should parse version flag', () => {
      compiler = CompactCompiler.fromArgs(['+0.26.0']);

      expect(compiler.testOptions.version).toBe('0.26.0');
      expect(compiler.testOptions.flags).toEqual([]);
    });

    it('should parse complex arguments', () => {
      compiler = CompactCompiler.fromArgs([
        '--dir',
        'security',
        '--skip-zk',
        '--trace-passes',
        '+0.26.0',
      ]);

      expect(compiler.testOptions.targetDir).toBe('security');
      expect(compiler.testOptions.flags).toEqual([
        '--skip-zk',
        '--trace-passes',
      ]);
      expect(compiler.testOptions.version).toBe('0.26.0');
    });

    it('should combine environment variables with CLI flags', () => {
      compiler = CompactCompiler.fromArgs(
        ['--dir', 'access', '--trace-passes'],
        {
          SKIP_ZK: 'true',
        },
      );

      expect(compiler.testOptions.targetDir).toBe('access');
      expect(compiler.testOptions.flags).toEqual([
        '--skip-zk',
        '--trace-passes',
      ]);
    });

    it('should deduplicate flags when both env var and CLI flag are present', () => {
      compiler = CompactCompiler.fromArgs(['--skip-zk', '--trace-passes'], {
        SKIP_ZK: 'true',
      });

      expect(compiler.testOptions.flags).toEqual([
        '--skip-zk',
        '--trace-passes',
      ]);
    });

    it('should throw error for --dir without argument', () => {
      expect(() => CompactCompiler.fromArgs(['--dir'])).toThrow(
        '--dir flag requires a directory name',
      );
    });

    it('should throw error for --dir followed by another flag', () => {
      expect(() => CompactCompiler.fromArgs(['--dir', '--skip-zk'])).toThrow(
        '--dir flag requires a directory name',
      );
    });

    it('should parse --hierarchical flag', () => {
      compiler = CompactCompiler.fromArgs(['--hierarchical']);

      expect(compiler.testOptions.hierarchical).toBe(true);
      expect(compiler.testOptions.flags).toEqual([]);
    });

    it('should parse --hierarchical flag with other options', () => {
      compiler = CompactCompiler.fromArgs([
        '--hierarchical',
        '--dir',
        'security',
        '--skip-zk',
        '+0.26.0',
      ]);

      expect(compiler.testOptions.hierarchical).toBe(true);
      expect(compiler.testOptions.targetDir).toBe('security');
      expect(compiler.testOptions.flags).toEqual(['--skip-zk']);
      expect(compiler.testOptions.version).toBe('0.26.0');
    });

    it('should default to flattened output (hierarchical = false)', () => {
      compiler = CompactCompiler.fromArgs(['--skip-zk']);

      expect(compiler.testOptions.hierarchical).toBe(false);
    });

    it('should parse --src flag', () => {
      compiler = CompactCompiler.fromArgs(['--src', 'contracts']);

      expect(compiler.testOptions.srcDir).toBe('contracts');
    });

    it('should parse --out flag', () => {
      compiler = CompactCompiler.fromArgs(['--out', 'build']);

      expect(compiler.testOptions.outDir).toBe('build');
    });

    it('should parse --src and --out flags together', () => {
      compiler = CompactCompiler.fromArgs([
        '--src',
        'contracts',
        '--out',
        'dist/artifacts',
        '--skip-zk',
      ]);

      expect(compiler.testOptions.srcDir).toBe('contracts');
      expect(compiler.testOptions.outDir).toBe('dist/artifacts');
      expect(compiler.testOptions.flags).toEqual(['--skip-zk']);
    });

    it('should use default srcDir and outDir when not specified', () => {
      compiler = CompactCompiler.fromArgs([]);

      expect(compiler.testOptions.srcDir).toBe('src');
      expect(compiler.testOptions.outDir).toBe('artifacts');
    });

    it('should throw error for --src without argument', () => {
      expect(() => CompactCompiler.fromArgs(['--src'])).toThrow(
        '--src flag requires a directory path',
      );
    });

    it('should throw error for --src followed by another flag', () => {
      expect(() => CompactCompiler.fromArgs(['--src', '--skip-zk'])).toThrow(
        '--src flag requires a directory path',
      );
    });

    it('should throw error for --out without argument', () => {
      expect(() => CompactCompiler.fromArgs(['--out'])).toThrow(
        '--out flag requires a directory path',
      );
    });

    it('should throw error for --out followed by another flag', () => {
      expect(() => CompactCompiler.fromArgs(['--out', '--skip-zk'])).toThrow(
        '--out flag requires a directory path',
      );
    });
  });

  describe('validateEnvironment', () => {
    it('should validate successfully and display environment info', async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: 'compact 0.1.0', stderr: '' }) // checkCompactAvailable
        .mockResolvedValueOnce({ stdout: 'compact 0.1.0', stderr: '' }) // getDevToolsVersion
        .mockResolvedValueOnce({
          stdout: 'Compactc version: 0.26.0',
          stderr: '',
        }); // getToolchainVersion

      compiler = new CompactCompiler(
        {
          flags: ['--skip-zk'],
          targetDir: 'security',
          version: '0.26.0',
        },
        mockExec,
      );
      const displaySpy = vi
        .spyOn(UIService, 'displayEnvInfo')
        .mockImplementation(() => {});

      await expect(compiler.validateEnvironment()).resolves.not.toThrow();

      // Check steps
      expect(mockExec).toHaveBeenCalledTimes(3);
      expect(mockExec).toHaveBeenNthCalledWith(1, 'compact --version'); // validate() calls
      expect(mockExec).toHaveBeenNthCalledWith(2, 'compact --version'); // getDevToolsVersion()
      expect(mockExec).toHaveBeenNthCalledWith(
        3,
        'compact compile +0.26.0 --version',
      ); // getToolchainVersion()

      // Verify passed args
      expect(displaySpy).toHaveBeenCalledWith(
        'compact 0.1.0',
        'Compactc version: 0.26.0',
        'security',
        '0.26.0',
      );

      displaySpy.mockRestore();
    });

    it('should handle CompactCliNotFoundError with installation instructions', async () => {
      mockExec.mockRejectedValue(new Error('Command not found'));
      compiler = new CompactCompiler({}, mockExec);

      await expect(compiler.validateEnvironment()).rejects.toThrow(
        CompactCliNotFoundError,
      );
    });

    it('should handle version retrieval failures after successful CLI check', async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: 'compact 0.1.0', stderr: '' }) // validate() succeeds
        .mockRejectedValueOnce(new Error('Version command failed')); // getDevToolsVersion() fails

      compiler = new CompactCompiler({}, mockExec);

      await expect(compiler.validateEnvironment()).rejects.toThrow(
        'Version command failed',
      );
    });

    it('should handle PromisifiedChildProcessError specifically', async () => {
      const childProcessError = new Error('Command execution failed') as any;
      childProcessError.stdout = 'some output';
      childProcessError.stderr = 'some error';

      mockExec.mockRejectedValue(childProcessError);
      compiler = new CompactCompiler({}, mockExec);

      await expect(compiler.validateEnvironment()).rejects.toThrow(
        "'compact' CLI not found in PATH. Please install the Compact developer tools.",
      );
    });

    it('should handle non-Error exceptions gracefully', async () => {
      mockExec.mockRejectedValue('String error message');
      compiler = new CompactCompiler({}, mockExec);

      await expect(compiler.validateEnvironment()).rejects.toThrow(
        CompactCliNotFoundError,
      );
    });

    it('should validate with specific version flag', async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: 'compact 0.1.0', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'compact 0.1.0', stderr: '' })
        .mockResolvedValueOnce({
          stdout: 'Compactc version: 0.26.0',
          stderr: '',
        });

      compiler = new CompactCompiler({ version: '0.26.0' }, mockExec);
      const displaySpy = vi
        .spyOn(UIService, 'displayEnvInfo')
        .mockImplementation(() => {});

      await compiler.validateEnvironment();

      // Verify version-specific toolchain call
      expect(mockExec).toHaveBeenNthCalledWith(
        3,
        'compact compile +0.26.0 --version',
      );
      expect(displaySpy).toHaveBeenCalledWith(
        'compact 0.1.0',
        'Compactc version: 0.26.0',
        undefined, // no targetDir
        '0.26.0',
      );

      displaySpy.mockRestore();
    });

    it('should validate without target directory or version', async () => {
      mockExec
        .mockResolvedValueOnce({ stdout: 'compact 0.1.0', stderr: '' })
        .mockResolvedValueOnce({ stdout: 'compact 0.1.0', stderr: '' })
        .mockResolvedValueOnce({
          stdout: 'Compactc version: 0.26.0',
          stderr: '',
        });

      compiler = new CompactCompiler({}, mockExec);
      const displaySpy = vi
        .spyOn(UIService, 'displayEnvInfo')
        .mockImplementation(() => {});

      await compiler.validateEnvironment();

      // Verify default toolchain call (no version flag)
      expect(mockExec).toHaveBeenNthCalledWith(3, 'compact compile  --version');
      expect(displaySpy).toHaveBeenCalledWith(
        'compact 0.1.0',
        'Compactc version: 0.26.0',
        undefined,
        undefined,
      );

      displaySpy.mockRestore();
    });
  });

  describe('compile', () => {
    it('should handle empty source directory', async () => {
      mockReaddir.mockResolvedValue([]);
      compiler = new CompactCompiler({}, mockExec);

      await expect(compiler.compile()).resolves.not.toThrow();
    });

    it('should throw error if target directory does not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      compiler = new CompactCompiler({ targetDir: 'nonexistent' }, mockExec);

      await expect(compiler.compile()).rejects.toThrow(DirectoryNotFoundError);
    });

    it('should compile files successfully', async () => {
      const mockDirents = [
        {
          name: 'MyToken.compact',
          isFile: () => true,
          isDirectory: () => false,
        },
        {
          name: 'Ownable.compact',
          isFile: () => true,
          isDirectory: () => false,
        },
      ];
      mockReaddir.mockResolvedValue(mockDirents as any);
      compiler = new CompactCompiler({ flags: ['--skip-zk'] }, mockExec);

      await compiler.compile();

      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('compact compile --skip-zk'),
      );
    });

    it('should handle compilation errors gracefully', async () => {
      const brokenDirent = {
        name: 'Broken.compact',
        isFile: () => true,
        isDirectory: () => false,
      };

      const mockDirents = [brokenDirent];
      mockReaddir.mockResolvedValue(mockDirents as any);
      mockExistsSync.mockReturnValue(true);

      const testMockExec = vi
        .fn()
        .mockResolvedValueOnce({ stdout: 'compact 0.1.0', stderr: '' }) // checkCompactAvailable
        .mockResolvedValueOnce({ stdout: 'compact 0.1.0', stderr: '' }) // getDevToolsVersion
        .mockResolvedValueOnce({ stdout: 'Compactc 0.26.0', stderr: '' }) // getToolchainVersion
        .mockRejectedValueOnce(new Error('Compilation failed')); // compileFile execution

      compiler = new CompactCompiler({}, testMockExec);

      // Test that compilation errors are properly propagated
      let thrownError: unknown;
      try {
        await compiler.compile();
        expect.fail('Expected compilation to throw an error');
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeInstanceOf(Error);
      expect((thrownError as Error).message).toBe(
        `Failed to compile ${brokenDirent.name}: Compilation failed`,
      );
      expect(testMockExec).toHaveBeenCalledTimes(4);
    });
  });

  describe('Real-world scenarios', () => {
    beforeEach(() => {
      const mockDirents = [
        {
          name: 'AccessControl.compact',
          isFile: () => true,
          isDirectory: () => false,
        },
      ];
      mockReaddir.mockResolvedValue(mockDirents as any);
    });

    it('should handle turbo compact command', () => {
      compiler = CompactCompiler.fromArgs([]);

      expect(compiler.testOptions.flags).toEqual([]);
      expect(compiler.testOptions.targetDir).toBeUndefined();
    });

    it('should handle SKIP_ZK=true turbo compact command', () => {
      compiler = CompactCompiler.fromArgs([], { SKIP_ZK: 'true' });

      expect(compiler.testOptions.flags).toEqual(['--skip-zk']);
    });

    it('should handle turbo compact:access command', () => {
      compiler = CompactCompiler.fromArgs(['--dir', 'access']);

      expect(compiler.testOptions.flags).toEqual([]);
      expect(compiler.testOptions.targetDir).toBe('access');
    });

    it('should handle turbo compact:security -- --skip-zk command', () => {
      compiler = CompactCompiler.fromArgs(['--dir', 'security', '--skip-zk']);

      expect(compiler.testOptions.flags).toEqual(['--skip-zk']);
      expect(compiler.testOptions.targetDir).toBe('security');
    });

    it('should handle version specification', () => {
      compiler = CompactCompiler.fromArgs(['+0.26.0']);

      expect(compiler.testOptions.version).toBe('0.26.0');
    });

    it.each([
      {
        name: 'with skip zk env var only',
        args: [
          '--dir',
          'security',
          '--no-communications-commitment',
          '+0.26.0',
        ],
        env: { SKIP_ZK: 'true' },
      },
      {
        name: 'with skip-zk flag only',
        args: [
          '--dir',
          'security',
          '--skip-zk',
          '--no-communications-commitment',
          '+0.26.0',
        ],
        env: { SKIP_ZK: 'false' },
      },
      {
        name: 'with both skip-zk flag and env var',
        args: [
          '--dir',
          'security',
          '--skip-zk',
          '--no-communications-commitment',
          '+0.26.0',
        ],
        env: { SKIP_ZK: 'true' },
      },
    ])('should handle complex command $name', ({ args, env }) => {
      compiler = CompactCompiler.fromArgs(args, env);

      expect(compiler.testOptions.flags).toEqual([
        '--skip-zk',
        '--no-communications-commitment',
      ]);
      expect(compiler.testOptions.targetDir).toBe('security');
      expect(compiler.testOptions.version).toBe('0.26.0');
    });

    it('should parse --force flag', () => {
      compiler = CompactCompiler.fromArgs(['--force']);

      expect(compiler.testOptions.force).toBe(true);
    });

    it('should parse -f flag (short form)', () => {
      compiler = CompactCompiler.fromArgs(['-f']);

      expect(compiler.testOptions.force).toBe(true);
    });

    it('should parse --force with other flags', () => {
      compiler = CompactCompiler.fromArgs([
        '--hierarchical',
        '--force',
        '--skip-zk',
      ]);

      expect(compiler.testOptions.force).toBe(true);
      expect(compiler.testOptions.hierarchical).toBe(true);
      expect(compiler.testOptions.flags).toEqual(['--skip-zk']);
    });

    it('should default force to false', () => {
      compiler = CompactCompiler.fromArgs([]);

      expect(compiler.testOptions.force).toBe(false);
    });
  });
});

describe('ManifestService', () => {
  let manifestService: ManifestService;

  beforeEach(() => {
    vi.clearAllMocks();
    manifestService = new ManifestService('artifacts');
  });

  describe('manifestPath', () => {
    it('should return correct manifest path', () => {
      expect(manifestService.manifestPath).toBe(
        `artifacts/${MANIFEST_FILENAME}`,
      );
    });

    it('should use custom outDir', () => {
      const customService = new ManifestService('build/output');
      expect(customService.manifestPath).toBe(
        `build/output/${MANIFEST_FILENAME}`,
      );
    });
  });

  describe('read', () => {
    it('should return null when manifest does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await manifestService.read();

      expect(result).toBeNull();
    });

    it('should return manifest when it exists', async () => {
      const manifest = {
        structure: 'flattened',
        toolchainVersion: '0.26.0',
        createdAt: '2025-12-11T12:00:00Z',
        artifacts: ['Token', 'AccessControl'],
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(manifest));

      const result = await manifestService.read();

      expect(result).toEqual(manifest);
    });

    it('should return null on parse error', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue('invalid json');

      const result = await manifestService.read();

      expect(result).toBeNull();
    });

    it('should return null on read error', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockRejectedValue(new Error('Read error'));

      const result = await manifestService.read();

      expect(result).toBeNull();
    });
  });

  describe('write', () => {
    it('should write manifest to file', async () => {
      const manifest = {
        structure: 'hierarchical' as const,
        toolchainVersion: '0.26.0',
        createdAt: '2025-12-11T12:00:00Z',
        artifacts: ['Token'],
      };
      mockWriteFile.mockResolvedValue(undefined);

      await manifestService.write(manifest);

      expect(mockWriteFile).toHaveBeenCalledWith(
        `artifacts/${MANIFEST_FILENAME}`,
        JSON.stringify(manifest, null, 2),
      );
    });
  });

  describe('checkMismatch', () => {
    it('should return null when no manifest exists', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await manifestService.checkMismatch('flattened');

      expect(result).toBeNull();
    });

    it('should return null when structure matches', async () => {
      const manifest = {
        structure: 'flattened',
        createdAt: '2025-12-11T12:00:00Z',
        artifacts: ['Token'],
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(manifest));

      const result = await manifestService.checkMismatch('flattened');

      expect(result).toBeNull();
    });

    it('should return manifest when structure mismatches', async () => {
      const manifest = {
        structure: 'flattened',
        createdAt: '2025-12-11T12:00:00Z',
        artifacts: ['Token'],
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFile.mockResolvedValue(JSON.stringify(manifest));

      const result = await manifestService.checkMismatch('hierarchical');

      expect(result).toEqual(manifest);
    });
  });

  describe('cleanOutputDirectory', () => {
    it('should remove output directory when it exists', async () => {
      mockExistsSync.mockReturnValue(true);
      mockRm.mockResolvedValue(undefined);

      await manifestService.cleanOutputDirectory();

      expect(mockRm).toHaveBeenCalledWith('artifacts', {
        recursive: true,
        force: true,
      });
    });

    it('should not throw when directory does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(
        manifestService.cleanOutputDirectory(),
      ).resolves.not.toThrow();
      expect(mockRm).not.toHaveBeenCalled();
    });
  });
});

describe('StructureMismatchError', () => {
  it('should create error with correct properties', () => {
    const error = new StructureMismatchError('flattened', 'hierarchical');

    expect(error.name).toBe('StructureMismatchError');
    expect(error.existingStructure).toBe('flattened');
    expect(error.requestedStructure).toBe('hierarchical');
    expect(error.message).toContain('flattened');
    expect(error.message).toContain('hierarchical');
  });
});

describe('Hierarchical artifact tree structure', () => {
  let mockExec: MockedFunction<ExecFunction>;
  let compiler: CompactCompiler;
  let writtenManifest: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    writtenManifest = undefined;
    mockExec = vi.fn().mockResolvedValue({ stdout: 'success', stderr: '' });
    // existsSync returns true for src dir but false for manifest (no existing manifest)
    mockExistsSync.mockImplementation((path: string) => {
      if (path.includes('manifest.json')) return false;
      return true;
    });
    mockWriteFile.mockImplementation(async (_path, content) => {
      writtenManifest = JSON.parse(content as string);
    });
  });

  it('should create nested tree structure for hierarchical artifacts', async () => {
    // Mock: src/ has 'math' dir, math/ has Uint128.compact and 'test' dir, test/ has Uint128.mock.compact
    const mockSrcDir = [
      { name: 'math', isFile: () => false, isDirectory: () => true },
    ];
    const mockMathDir = [
      { name: 'Uint128.compact', isFile: () => true, isDirectory: () => false },
      { name: 'test', isFile: () => false, isDirectory: () => true },
    ];
    const mockTestDir = [
      {
        name: 'Uint128.mock.compact',
        isFile: () => true,
        isDirectory: () => false,
      },
    ];

    mockReaddir
      .mockResolvedValueOnce(mockSrcDir as any)
      .mockResolvedValueOnce(mockMathDir as any)
      .mockResolvedValueOnce(mockTestDir as any);

    compiler = new CompactCompiler({ hierarchical: true }, mockExec);
    await compiler.compile();

    const manifest = writtenManifest as {
      structure: string;
      artifacts: Record<string, unknown>;
    };
    expect(manifest.structure).toBe('hierarchical');
    expect(manifest.artifacts).toHaveProperty('math');
    const math = manifest.artifacts.math as {
      artifacts: string[];
      test: { artifacts: string[] };
    };
    expect(math).toHaveProperty('artifacts');
    expect(math.artifacts).toContain('Uint128');
    expect(math).toHaveProperty('test');
    expect(math.test.artifacts).toContain('Uint128.mock');
    // Contracts metadata is now in benchmarks.json, not in manifest
    expect(manifest).not.toHaveProperty('contracts');
  });

  it('should add root level artifacts to root node', async () => {
    const mockDirents = [
      {
        name: 'MyToken.compact',
        isFile: () => true,
        isDirectory: () => false,
      },
    ];
    mockReaddir.mockResolvedValue(mockDirents as any);

    compiler = new CompactCompiler({ hierarchical: true }, mockExec);
    await compiler.compile();

    const manifest = writtenManifest as {
      artifacts: { root: { artifacts: string[] } };
    };
    expect(manifest.artifacts).toHaveProperty('root');
    expect(manifest.artifacts.root.artifacts).toContain('MyToken');
  });

  it('should create flat array for flattened structure', async () => {
    const mockDirents = [
      {
        name: 'MyToken.compact',
        isFile: () => true,
        isDirectory: () => false,
      },
      {
        name: 'Ownable.compact',
        isFile: () => true,
        isDirectory: () => false,
      },
    ];
    mockReaddir.mockResolvedValue(mockDirents as any);

    compiler = new CompactCompiler({ hierarchical: false }, mockExec);
    await compiler.compile();

    const manifest = writtenManifest as {
      structure: string;
      artifacts: string[];
    };
    expect(manifest.structure).toBe('flattened');
    expect(Array.isArray(manifest.artifacts)).toBe(true);
    expect(manifest.artifacts).toContain('MyToken');
    expect(manifest.artifacts).toContain('Ownable');
  });

  it('should handle deeply nested directories', async () => {
    // Simulate: src/ -> access/ -> roles/ -> admin/ -> Admin.compact
    const mockSrcDir = [
      { name: 'access', isFile: () => false, isDirectory: () => true },
    ];
    const mockAccessDir = [
      { name: 'roles', isFile: () => false, isDirectory: () => true },
    ];
    const mockRolesDir = [
      { name: 'admin', isFile: () => false, isDirectory: () => true },
    ];
    const mockAdminDir = [
      { name: 'Admin.compact', isFile: () => true, isDirectory: () => false },
    ];

    mockReaddir
      .mockResolvedValueOnce(mockSrcDir as any)
      .mockResolvedValueOnce(mockAccessDir as any)
      .mockResolvedValueOnce(mockRolesDir as any)
      .mockResolvedValueOnce(mockAdminDir as any);

    compiler = new CompactCompiler({ hierarchical: true }, mockExec);
    await compiler.compile();

    const manifest = writtenManifest as {
      artifacts: {
        access: { roles: { admin: { artifacts: string[] } } };
      };
    };
    expect(manifest.artifacts.access.roles.admin.artifacts).toContain('Admin');
  });

  it('should write benchmarks file with contract metadata when benchmarksPath is set', async () => {
    const circuitOutput = `Compiling 2 circuits:
  circuit "mint" (k=14, rows=5000)
  circuit "burn" (k=14, rows=4800)
Overall progress [====================] 2/2`;

    // Return different outputs for module vs top-level contracts
    let compileCallCount = 0;
    mockExec.mockImplementation(async (cmd: string) => {
      if (cmd.includes('--version')) {
        return { stdout: 'compact 0.3.0', stderr: '' };
      }
      compileCallCount++;
      // First compile is module (Uint128), second is top-level (Uint128.mock)
      if (compileCallCount === 1) {
        return { stdout: 'compactc 0.26.0', stderr: '' };
      }
      return { stdout: 'compactc 0.26.0', stderr: circuitOutput };
    });

    const mockSrcDir = [
      { name: 'math', isFile: () => false, isDirectory: () => true },
    ];
    const mockMathDir = [
      { name: 'Uint128.compact', isFile: () => true, isDirectory: () => false },
      { name: 'test', isFile: () => false, isDirectory: () => true },
    ];
    const mockTestDir = [
      {
        name: 'Uint128.mock.compact',
        isFile: () => true,
        isDirectory: () => false,
      },
    ];

    mockReaddir
      .mockResolvedValueOnce(mockSrcDir as any)
      .mockResolvedValueOnce(mockMathDir as any)
      .mockResolvedValueOnce(mockTestDir as any);

    // Track what's written to the benchmarks file
    let writtenBenchmarks: string | null = null;
    vi.mocked(writeFile).mockImplementation(async (path, content) => {
      const pathStr = String(path);
      if (pathStr.includes('benchmarks.json')) {
        writtenBenchmarks = String(content);
      } else if (pathStr.includes('manifest.json')) {
        writtenManifest = JSON.parse(String(content));
      }
    });

    compiler = new CompactCompiler(
      { hierarchical: true, benchmarksPath: './benchmarks.json' },
      mockExec,
    );
    await compiler.compile();

    // Verify benchmarks file was written
    expect(writtenBenchmarks).not.toBeNull();
    const benchmarks = JSON.parse(writtenBenchmarks as string);

    // Verify structure and compactToolVersion are present
    expect(benchmarks).toHaveProperty('structure', 'hierarchical');
    expect(benchmarks).toHaveProperty('compactToolVersion');
    expect(benchmarks).toHaveProperty('compactcVersion');

    // Verify hierarchical structure matches artifacts structure
    expect(benchmarks.contracts).toHaveProperty('math');
    expect(benchmarks.contracts.math).toHaveProperty('contracts');
    expect(benchmarks.contracts.math).toHaveProperty('test');

    // Verify module contract (no circuits)
    expect(benchmarks.contracts.math.contracts.Uint128).toEqual({
      type: 'module',
    });

    // Verify top-level contract (with circuits)
    const mockContract =
      benchmarks.contracts.math.test.contracts['Uint128.mock'];
    expect(mockContract.type).toBe('top-level');
    expect(mockContract.circuits).toHaveLength(2);
    expect(mockContract.circuits).toEqual([
      { name: 'mint', k: 14, rows: 5000 },
      { name: 'burn', k: 14, rows: 4800 },
    ]);

    // Manifest should not have contracts
    expect(writtenManifest).not.toHaveProperty('contracts');
  });
});
