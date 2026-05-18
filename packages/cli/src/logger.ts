import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

/**
 * Pino logger factory tuned for the CLI's three modes.
 *
 *   --json            : raw JSON to stdout, no transports (CI-friendly).
 *   default           : pretty-printed `info+` to stdout via `pino-pretty`.
 *   --verbose (no json): same pretty stdout AND `debug+` mirrored to a
 *                       timestamped file under `.compact/logs/` so the
 *                       transcript survives ephemeral spinner overwrites.
 */
export interface CreateLoggerOptions {
  verbose: boolean;
  json: boolean;
  logDir?: string;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  if (opts.json) {
    return pino({ level: opts.verbose ? 'debug' : 'info' });
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
