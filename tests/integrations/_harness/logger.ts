import pino, { type Logger } from 'pino';

let sharedLogger: Logger | undefined;

/**
 * Process-shared pino logger, level controlled by `LOG_LEVEL` (defaults to
 * `warn` to keep test output clean). Specs that want chatty output can run
 * `LOG_LEVEL=debug yarn test:integration`.
 */
export function testLogger(): Logger {
  if (!sharedLogger) {
    sharedLogger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
  }
  return sharedLogger;
}
