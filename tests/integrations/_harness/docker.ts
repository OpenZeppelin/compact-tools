import { execFileSync } from 'node:child_process';

/**
 * Running containers the `"auto"` proof server owns. testkit names them
 * `proof-server_<uid>`; the local stack's own server is
 * `integrations-proof-server-1` and stays out of the filter.
 *
 * `dispose` stops the container without removing it, so this only counts
 * what is still running.
 */
export function runningAutoProofServers(): string[] {
  const names = execFileSync(
    'docker',
    ['ps', '--filter', 'name=^proof-server_', '--format', '{{.Names}}'],
    { encoding: 'utf8' },
  );
  return names.split('\n').filter((name) => name.length > 0);
}
