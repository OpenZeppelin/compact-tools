import {
  DynamicProofServerContainer,
  StaticProofServerContainer,
} from '@midnight-ntwrk/testkit-js';
import type { Logger } from 'pino';
import type { NetworkConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';

/**
 * Inputs to {@link ProofServer.start}; same shape the free function took
 * before the class refactor.
 */
export interface ProofServerOptions {
  cliOverride?: string;
  network: NetworkConfig;
  logger: Logger;
}

/**
 * Proof-server handle: a resolved URL plus the lifecycle needed to release
 * any underlying container.
 *
 * Always acquired via {@link ProofServer.start}, which walks the five-step
 * precedence chain (CLI > TOML URL > `"auto"` container > `PROOF_SERVER_PORT`
 * > `http://127.0.0.1:6300`). Call {@link dispose} on teardown regardless of
 * how it was acquired — it's a no-op for static URLs and a container-stop
 * for the auto / port paths.
 */
export class ProofServer {
  /** Resolved URL the proof provider POSTs to. */
  readonly url: string;
  readonly #dispose: () => Promise<void>;

  private constructor(url: string, dispose: () => Promise<void>) {
    this.url = url;
    this.#dispose = dispose;
  }

  /**
   * Resolve a proof-server URL for the target network.
   *
   * Precedence (highest first):
   *  1. `cliOverride` (e.g. `--proof-server <url>`)
   *  2. `[networks.X].proof_server = "<url>"` (TOML static URL)
   *  3. `[networks.X].proof_server = "auto"` (boots a docker container via
   *     testkit-js; {@link dispose} stops it)
   *  4. `PROOF_SERVER_PORT` env (static container on localhost)
   *  5. `http://127.0.0.1:6300` (final default)
   */
  static async start(opts: ProofServerOptions): Promise<ProofServer> {
    const { cliOverride, network, logger } = opts;
    const explicit = cliOverride ?? network.proof_server;

    if (explicit && explicit !== 'auto') {
      logger.debug(`Using configured proof server: ${explicit}`);
      return ProofServer.fromStaticUrl(explicit);
    }

    if (explicit === 'auto') {
      logger.info('Starting proof-server container (auto)…');
      const container = await DynamicProofServerContainer.start(
        logger,
        undefined,
        network.network_id,
      );
      return new ProofServer(container.getUrl(), () => container.stop());
    }

    const port = process.env.PROOF_SERVER_PORT;
    if (port !== undefined) {
      const parsed = Number.parseInt(port, 10);
      if (Number.isNaN(parsed)) {
        throw new ConfigError(`Invalid PROOF_SERVER_PORT: ${port}`);
      }
      logger.debug(`Using PROOF_SERVER_PORT=${parsed}`);
      const container = new StaticProofServerContainer(parsed);
      return new ProofServer(container.getUrl(), () => container.stop());
    }

    logger.debug('Falling back to default proof server at http://127.0.0.1:6300');
    return ProofServer.fromStaticUrl('http://127.0.0.1:6300');
  }

  private static fromStaticUrl(url: string): ProofServer {
    return new ProofServer(url, async () => {
      /* no container to stop */
    });
  }

  /** Release any underlying container. Idempotent for static-URL instances. */
  async dispose(): Promise<void> {
    return this.#dispose();
  }
}
