import { DustSecretKey, ZswapSecretKeys } from '@midnight-ntwrk/ledger-v8';
import {
  DEFAULT_DUST_OPTIONS,
  type DustWalletOptions,
  type EnvironmentConfiguration,
  FluentWalletBuilder,
  MidnightWalletProvider,
} from '@midnight-ntwrk/testkit-js';
import type { WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import type { Logger } from 'pino';
import type { WalletSeed } from './seeds.ts';

/**
 * Owned deployer wallet handle: a built `MidnightWalletProvider` paired
 * with the lifecycle needed to release it.
 *
 * Always acquired via {@link WalletHandler.build} and handed to
 * `AsyncDisposableStack.use()` (or `await using`) — the dispose hook
 * stops the wallet and warn-logs any error so a failed teardown doesn't
 * mask the deploy's primary failure.
 *
 * Mirrors the {@link ProofServer} pattern in `providers/proof-server.ts`.
 * The underlying testkit provider is exposed via {@link provider}; pass
 * that to anything that wants a plain `MidnightWalletProvider`.
 */
export class WalletHandler implements AsyncDisposable {
  /** The underlying testkit-js wallet provider. */
  readonly provider: MidnightWalletProvider;
  readonly #logger: Logger;

  private constructor(provider: MidnightWalletProvider, logger: Logger) {
    this.provider = provider;
    this.#logger = logger;
  }

  /**
   * Build a `MidnightWalletProvider` with dust options tuned for the
   * target network, wrapped in a `WalletHandler` for safe teardown.
   *
   * Two things this fixes vs. the bare `MidnightWalletProvider.build`:
   *
   *  1. **Dust overhead.** testkit-js' default `additionalFeeOverhead`
   *     is `1_000n`, which is too low for the dev-preset `undeployed`
   *     node — every deploy then fails with a generic
   *     `SubmissionError`. CMA's harness bumps to `5e17` for
   *     undeployed; we mirror that.
   *
   *  2. **Mnemonic-vs-hex routing.** `FluentWalletBuilder.withMnemonic`
   *     and `.withSeed(hex)` derive *different* wallets from the same
   *     input — `withMnemonic` runs the BIP39 → seed → wallet path
   *     expected by the genesis-funded test mnemonic (`TEST_MNEMONIC`),
   *     while a hex seed is interpreted as already-derived entropy.
   *     Keeping the seed's `kind` explicit lets us pick the right
   *     builder method.
   *
   * Caller still drives `provider.start(waitForFunds)` (and any faucet
   * hit); teardown is automatic via `await using` or
   * `stack.use(wallet)`.
   */
  static async build(
    logger: Logger,
    env: EnvironmentConfiguration,
    seed: WalletSeed,
  ): Promise<WalletHandler> {
    const dustOptions: DustWalletOptions = {
      ...DEFAULT_DUST_OPTIONS,
      additionalFeeOverhead:
        env.walletNetworkId === 'undeployed'
          ? 500_000_000_000_000_000n
          : DEFAULT_DUST_OPTIONS.additionalFeeOverhead,
    };

    const builder =
      FluentWalletBuilder.forEnvironment(env).withDustOptions(dustOptions);
    const seeded =
      seed.kind === 'mnemonic'
        ? builder.withMnemonic(seed.value)
        : builder.withSeed(seed.value);

    const build = await seeded.buildWithoutStarting();
    const { wallet, seeds, keystore } = build as unknown as {
      wallet: WalletFacade;
      seeds: { shielded: Uint8Array; dust: Uint8Array };
      keystore: Parameters<typeof MidnightWalletProvider.withWallet>[5];
    };

    const provider = await MidnightWalletProvider.withWallet(
      logger,
      env,
      wallet,
      ZswapSecretKeys.fromSeed(seeds.shielded),
      DustSecretKey.fromSeed(seeds.dust),
      keystore,
    );

    return new WalletHandler(provider, logger);
  }

  /**
   * Stop the underlying wallet. Swallows the error with a `warn` log so
   * a failed dispose doesn't mask the deploy's real error.
   */
  async [Symbol.asyncDispose](): Promise<void> {
    try {
      await this.provider.stop();
    } catch (e) {
      this.#logger.warn({ err: (e as Error).message }, 'Wallet stop failed');
    }
  }
}
