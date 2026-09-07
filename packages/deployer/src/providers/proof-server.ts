import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DynamicProofServerContainer,
  getContainersConfiguration,
  StaticProofServerContainer,
  setContainersConfiguration,
} from '@midnight-ntwrk/testkit-js';
import type { Logger } from 'pino';
import type { NetworkConfig } from '../config/schema.ts';
import { ConfigError } from '../errors.ts';
import { formatError } from '../services/error-format.ts';

export interface ProofServerOptions {
  cliOverride?: string;
  network: NetworkConfig;
  logger: Logger;
}

/** Holds the packaged `proof-server.yml`. Two levels up from `providers/` in
 *  both `src/` and the built `dist/`. */
const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/**
 * Point testkit at a compose file it can read.
 *
 * testkit boots the `auto` container from `<proofServer.path>/<fileName>` and
 * defaults that path to `process.cwd()`. A compose file in the cwd still wins,
 * as the escape hatch for a different image; otherwise the packaged one. The
 * choice is remade on every start because testkit's config is global.
 */
function useComposeFile(logger: Logger): void {
  const current = getContainersConfiguration();
  const { fileName } = current.proofServer;
  const cwd = process.cwd();
  const path = existsSync(resolve(cwd, fileName)) ? cwd : PACKAGE_ROOT;

  logger.debug(`Proof-server compose file: ${resolve(path, fileName)}`);
  setContainersConfiguration({
    ...current,
    proofServer: { ...current.proofServer, path },
  });
}

/**
 * Proof-server handle with a resolved URL + lifecycle. Always acquired via
 * {@link ProofServer.start}; {@link dispose} is a no-op for static URLs
 * and a container-stop for the `auto` / `PROOF_SERVER_PORT` paths.
 */
export class ProofServer {
  /** Resolved URL the proof provider POSTs to. */
  readonly url: string;
  readonly #dispose: () => Promise<void>;
  readonly #logger: Logger;

  private constructor(
    url: string,
    dispose: () => Promise<void>,
    logger: Logger,
  ) {
    this.url = url;
    this.#dispose = dispose;
    this.#logger = logger;
  }

  /**
   * Resolve URL by precedence: `cliOverride` > TOML `proof_server` URL >
   * `proof_server = "auto"` (boots container) > `PROOF_SERVER_PORT` env >
   * `http://127.0.0.1:6300`.
   */
  static async start(opts: ProofServerOptions): Promise<ProofServer> {
    const { cliOverride, network, logger } = opts;
    const explicit = cliOverride ?? network.proof_server;

    if (explicit && explicit !== 'auto') {
      logger.debug(`Using configured proof server: ${explicit}`);
      return ProofServer.fromStaticUrl(explicit, logger);
    }

    if (explicit === 'auto') {
      logger.info('Starting proof-server container (auto)…');
      useComposeFile(logger);
      const container = await DynamicProofServerContainer.start(
        logger,
        undefined,
        network.network_id,
      );
      return new ProofServer(
        container.getUrl(),
        () => container.stop(),
        logger,
      );
    }

    const port = process.env.PROOF_SERVER_PORT;
    if (port !== undefined) {
      if (!/^\d+$/.test(port)) {
        throw new ConfigError(`Invalid PROOF_SERVER_PORT: ${port}`);
      }
      const parsed = Number(port);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new ConfigError(`Invalid PROOF_SERVER_PORT: ${port}`);
      }
      logger.debug(`Using PROOF_SERVER_PORT=${parsed}`);
      const container = new StaticProofServerContainer(parsed);
      return new ProofServer(
        container.getUrl(),
        () => container.stop(),
        logger,
      );
    }

    logger.debug(
      'Falling back to default proof server at http://127.0.0.1:6300',
    );
    return ProofServer.fromStaticUrl('http://127.0.0.1:6300', logger);
  }

  private static fromStaticUrl(url: string, logger: Logger): ProofServer {
    return new ProofServer(
      url,
      async () => {
        /* no container to stop */
      },
      logger,
    );
  }

  /** Release any underlying container. Idempotent for static-URL instances. */
  async dispose(): Promise<void> {
    return this.#dispose();
  }

  /** `await using` hook: swallows teardown errors so they don't mask the deploy's real error. */
  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.#dispose();
    } catch (e) {
      this.#logger.warn({ err: formatError(e) }, 'Proof server dispose failed');
    }
  }
}
