import { Deployer } from '@openzeppelin/compact-deployer/deployer';
import { ConfigError } from '@openzeppelin/compact-deployer/errors';
import { describe, expect, it } from 'vitest';
import { testLogger } from '../../_harness/logger.ts';
import { CONFIG_PATH } from '../../_harness/paths.ts';

/**
 * Spec: Deployer.prepare surfaces typed `ConfigError`s for foreseeable
 * user mistakes, with messages that name the offending key/value. These
 * never get past config validation, so no artifact and no live stack
 * are needed.
 */
describe('compact-deploy — config errors are typed and actionable', () => {
  /** Both the class and the message: the message is the user's only clue. */
  async function expectConfigError(
    prepare: Promise<unknown>,
    message: RegExp,
  ): Promise<void> {
    const error = await prepare.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toHaveProperty('message', expect.stringMatching(message));
  }

  it('should name the unknown contract and list the defined ones', async () => {
    await expectConfigError(
      Deployer.prepare({
        contract: 'Nonexistent',
        network: 'local',
        configPath: CONFIG_PATH,
        logger: testLogger(),
      }),
      /Contract "Nonexistent" not defined\. Available: .*\bCounter\b/,
    );
  });

  it('should name the unknown network and list the defined ones', async () => {
    await expectConfigError(
      Deployer.prepare({
        contract: 'Counter',
        network: 'unknown-network',
        configPath: CONFIG_PATH,
        logger: testLogger(),
      }),
      /Network "unknown-network" not defined\. Available: .*\blocal\b/,
    );
  });

  it('should name the compact.toml path that does not exist', async () => {
    await expectConfigError(
      Deployer.prepare({
        contract: 'Counter',
        network: 'local',
        configPath: '/nonexistent/compact.toml',
        logger: testLogger(),
      }),
      /--config path does not exist: \/nonexistent\/compact\.toml/,
    );
  });
});
