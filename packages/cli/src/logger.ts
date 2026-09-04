import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

/**
 * Pino factory for the three CLI modes: `--json` (raw JSON to STDERR, no
 * transports — STDOUT is reserved for the single result object), default
 * (pretty `info+`), `--verbose` (pretty `info+` to stdout AND `debug+`
 * mirrored to `.compact/logs/<ts>.log` so the transcript survives spinner
 * overwrites).
 */
export interface CreateLoggerOptions {
  verbose: boolean;
  json: boolean;
  logDir?: string;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  if (opts.json) {
    // fd 2 = STDERR; keeps STDOUT carrying only the final JSON result.
    return pino(
      { level: opts.verbose ? 'debug' : 'info' },
      pino.destination(2),
    );
  }

  if (opts.verbose) {
    const dir = opts.logDir ?? join(process.cwd(), '.compact', 'logs');
    mkdirSync(dir, { recursive: true });
    const file = join(
      dir,
      `${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
    );
    return pino(
      { level: 'debug' },
      pino.transport({
        targets: [
          {
            target: 'pino/file',
            options: { destination: file },
            level: 'debug',
          },
          {
            target: 'pino-pretty',
            options: {
              destination: 1,
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
            },
            level: 'info',
          },
        ],
      }),
    );
  }

  return pino(
    { level: 'info' },
    pino.transport({
      target: 'pino-pretty',
      options: {
        destination: 1,
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
      },
    }),
  );
}
