import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockMkdirSync, mockPino, mockTransport, fakeLogger } = vi.hoisted(
  () => {
    const fakeLogger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    };
    return {
      mockMkdirSync: vi.fn(),
      mockPino: vi.fn(() => fakeLogger),
      mockTransport: vi.fn((cfg: unknown) => ({ __transport: cfg })),
      fakeLogger,
    };
  },
);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: mockMkdirSync };
});

vi.mock('pino', () => {
  const pinoFn = (...args: unknown[]) => mockPino(...(args as [])) as unknown;
  (pinoFn as unknown as { transport: typeof mockTransport }).transport =
    mockTransport;
  return { default: pinoFn };
});

import { createLogger } from '../src/logger.ts';

describe('createLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('json mode', () => {
    it('should return logger at info level when verbose false', () => {
      const logger = createLogger({ verbose: false, json: true });

      expect(mockPino).toHaveBeenCalledTimes(1);
      expect(mockPino).toHaveBeenCalledWith({ level: 'info' });
      expect(mockTransport).not.toHaveBeenCalled();
      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(logger).toBe(fakeLogger);
    });

    it('should return logger at debug level when verbose true', () => {
      const logger = createLogger({ verbose: true, json: true });

      expect(mockPino).toHaveBeenCalledWith({ level: 'debug' });
      expect(mockTransport).not.toHaveBeenCalled();
      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(logger).toBe(fakeLogger);
    });
  });

  describe('pretty mode (default, non-json)', () => {
    it('should configure single pino-pretty transport when not verbose', () => {
      const logger = createLogger({ verbose: false, json: false });

      expect(mockPino).toHaveBeenCalledTimes(1);
      const [opts, transport] = mockPino.mock.calls[0] as [
        { level: string },
        unknown,
      ];
      expect(opts).toEqual({ level: 'info' });
      expect(transport).toEqual({
        __transport: {
          target: 'pino-pretty',
          options: {
            destination: 1,
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      });
      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(logger).toBe(fakeLogger);
    });
  });

  describe('verbose pretty mode', () => {
    it('should mkdir the default log dir and configure two transports', () => {
      const logger = createLogger({ verbose: true, json: false });

      expect(mockMkdirSync).toHaveBeenCalledTimes(1);
      const [dirArg, mkdirOpts] = mockMkdirSync.mock.calls[0] as [
        string,
        { recursive: boolean },
      ];
      expect(dirArg).toContain('.compact');
      expect(dirArg).toContain('logs');
      expect(mkdirOpts).toEqual({ recursive: true });

      expect(mockPino).toHaveBeenCalledTimes(1);
      const [opts, transport] = mockPino.mock.calls[0] as [
        { level: string },
        { __transport: { targets: Record<string, unknown>[] } },
      ];
      expect(opts).toEqual({ level: 'debug' });
      expect(transport.__transport.targets).toHaveLength(2);
      expect(transport.__transport.targets[0]).toMatchObject({
        target: 'pino/file',
        level: 'debug',
      });
      expect(
        (
          transport.__transport.targets[0] as {
            options: { destination: string };
          }
        ).options.destination,
      ).toMatch(/\.log$/);
      expect(transport.__transport.targets[1]).toMatchObject({
        target: 'pino-pretty',
        level: 'info',
        options: {
          destination: 1,
          colorize: true,
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      });
      expect(logger).toBe(fakeLogger);
    });

    it('should honour a custom logDir override', () => {
      createLogger({ verbose: true, json: false, logDir: '/tmp/custom-logs' });

      expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/custom-logs', {
        recursive: true,
      });
      const transport = (
        mockPino.mock.calls[0] as [
          unknown,
          {
            __transport: {
              targets: Array<{ options: { destination: string } }>;
            };
          },
        ]
      )[1];
      expect(transport.__transport.targets[0]?.options.destination).toContain(
        '/tmp/custom-logs/',
      );
    });
  });

  describe('return value shape', () => {
    it('should expose the pino logger contract for every mode combination', () => {
      const matrix: Array<{ verbose: boolean; json: boolean }> = [
        { verbose: false, json: false },
        { verbose: true, json: false },
        { verbose: false, json: true },
        { verbose: true, json: true },
      ];
      for (const opts of matrix) {
        const logger = createLogger({
          ...opts,
          logDir: '/tmp/logger-shape-test',
        });
        expect(typeof logger.trace).toBe('function');
        expect(typeof logger.debug).toBe('function');
        expect(typeof logger.info).toBe('function');
        expect(typeof logger.warn).toBe('function');
        expect(typeof logger.error).toBe('function');
        expect(typeof logger.fatal).toBe('function');
        expect(typeof logger.child).toBe('function');
      }
    });
  });
});
