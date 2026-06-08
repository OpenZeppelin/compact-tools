import { Deployer } from '@openzeppelin/compact-deployer/deployer';
import { ConfigError } from '@openzeppelin/compact-deployer/errors';
import { describe, expect, it } from 'vitest';
import { testLogger } from '../../_harness/logger.ts';
import { CONFIG_PATH, requireArtifact } from '../../_harness/paths.ts';

/**
 * Spec: Deployer.prepare surfaces typed `ConfigError`s for foreseeable
 * user mistakes, with messages that name the offending key/value. These
 * run against the live stack but never get past the config-validation
 * phase, so they're fast.
 */
describe('compact-deploy — config errors are typed and actionable', () => {
  it('should reject an unknown contract name', async () => {
    requireArtifact('Counter');
    await expect(
      Deployer.prepare({
        contract: 'Nonexistent',
        network: 'local',
        configPath: CONFIG_PATH,
        logger: testLogger(),
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('should reject an unknown network name', async () => {
    requireArtifact('Counter');
    await expect(
      Deployer.prepare({
        contract: 'Counter',
        network: 'unknown-network',
        configPath: CONFIG_PATH,
        logger: testLogger(),
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('should reject a missing compact.toml path', async () => {
    await expect(
      Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: '/nonexistent/compact.toml',
        logger: testLogger(),
      }),
    ).rejects.toThrow(ConfigError);
  });
});
