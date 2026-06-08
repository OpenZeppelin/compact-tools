import { resetSharedPool } from './walletPool.ts';

/**
 * Vitest `globalSetup` hook. The returned function runs once after the
 * suite, stopping every wallet built across all specs so the process
 * exits cleanly.
 */
export default function globalSetup(): () => Promise<void> {
  return async () => {
    await resetSharedPool();
  };
}
