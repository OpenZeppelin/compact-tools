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
import type { WalletSeed } from './normalize.ts';

/**
 * Build a `MidnightWalletProvider` with dust options tuned for the target
 * network.
 *
 * Two things this fixes vs. the bare `MidnightWalletProvider.build`:
 *
 *  1. **Dust overhead.** testkit-js' default `additionalFeeOverhead` is
 *     `1_000n`, which is too low for the dev-preset `undeployed` node —
 *     every deploy then fails with a generic `SubmissionError`. CMA's
 *     harness bumps to `5e17` for undeployed; we mirror that.
 *
 *  2. **Mnemonic-vs-hex routing.** `FluentWalletBuilder.withMnemonic` and
 *     `.withSeed(hex)` derive *different* wallets from the same input —
 *     `withMnemonic` runs the BIP39 → seed → wallet path expected by the
 *     genesis-funded test mnemonic (`TEST_MNEMONIC`), while a hex seed is
 *     interpreted as already-derived entropy. Keeping the seed's `kind`
 *     explicit lets us pick the right builder method.
 *
 * Caller still owns lifecycle: invoke `wallet.start(waitForFunds)` after
 * (and any faucet hit) and `wallet.stop()` on teardown.
 */
export async function buildDeployerWallet(
  logger: Logger,
  env: EnvironmentConfiguration,
  seed: WalletSeed,
): Promise<MidnightWalletProvider> {
  const dustOptions: DustWalletOptions = {
    ...DEFAULT_DUST_OPTIONS,
    additionalFeeOverhead:
      env.walletNetworkId === 'undeployed'
        ? 500_000_000_000_000_000n
        : DEFAULT_DUST_OPTIONS.additionalFeeOverhead,
  };

  const builder = FluentWalletBuilder.forEnvironment(env).withDustOptions(
    dustOptions,
  );
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

  return MidnightWalletProvider.withWallet(
    logger,
    env,
    wallet,
    ZswapSecretKeys.fromSeed(seeds.shielded),
    DustSecretKey.fromSeed(seeds.dust),
    keystore,
  );
}
