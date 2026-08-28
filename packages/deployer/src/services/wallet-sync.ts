import { shieldedToken, unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import type { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import {
  DustAddress,
  ShieldedAddress,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import type { FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';
import type { Logger } from 'pino';
import * as Rx from 'rxjs';
import { UnfundedWalletError } from '../errors.ts';

/**
 * Default sync ceiling (10 min). Overrides testkit-js's hardcoded 90 s
 * `waitForFunds` timeout, which is too short for real networks.
 */
export const DEFAULT_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Tolerated sync gap, in events, for the chain-tip gate.
 * `FacadeState.isSynced` requires every sub-wallet to be *strictly*
 * complete (gap 0). On a live network the global dust stream advances
 * continuously, so the dust wallet sits a few events behind the tip
 * indefinitely and strict `isSynced` never flips. The gate would then time
 * out on a wallet that is in fact fully usable. `isCompleteWithin(50)` is the
 * SDK default (and what the unshielded wallet uses internally): it treats
 * "within 50 events of tip" as synced, which a live wallet reaches and
 * holds. See OpenZeppelin/compact-tools#115.
 */
export const SYNC_MAX_GAP = 50n;

/**
 * Print the wallet's three bech32m addresses so the user can verify
 * the seed before a long sync. Best-effort: warn-and-continue on
 * failure.
 */
export async function logWalletAddresses(
  wallet: MidnightWalletProvider,
  logger: Logger,
): Promise<void> {
  try {
    const networkId = getNetworkId();
    const [shieldedState, unshieldedState, dustState] = await Promise.all([
      Rx.firstValueFrom(wallet.wallet.shielded.state),
      Rx.firstValueFrom(wallet.wallet.unshielded.state),
      Rx.firstValueFrom(wallet.wallet.dust.state),
    ]);
    const shielded = ShieldedAddress.codec
      .encode(networkId, shieldedState.address)
      .toString();
    const unshielded = UnshieldedAddress.codec
      .encode(networkId, unshieldedState.address)
      .toString();
    const dust = DustAddress.codec
      .encode(networkId, dustState.address)
      .toString();
    logger.info('Wallet addresses (verify these match your seed):');
    logger.info(`  shielded:   ${shielded}`);
    logger.info(`  unshielded: ${unshielded}`);
    logger.info(`  dust:       ${dust}`);
  } catch (e) {
    logger.warn(
      { err: (e as Error).message },
      'Could not derive wallet addresses for display; continuing',
    );
  }
}

/**
 * One-liner progress string for "Still syncing". Accepts both progress
 * shapes (shielded/dust use `appliedIndex`/`highestIndex`; unshielded
 * uses `appliedId`/`highestTransactionId`).
 */
export function describeProgress(p: {
  isStrictlyComplete: () => boolean;
}): string {
  const complete = p.isStrictlyComplete();
  const fields = p as unknown as {
    appliedIndex?: bigint;
    highestIndex?: bigint;
    highestRelevantIndex?: bigint;
    appliedId?: bigint;
    highestTransactionId?: bigint;
    isConnected?: boolean;
  };
  const applied = fields.appliedIndex ?? fields.appliedId ?? 0n;
  const highest = fields.highestIndex ?? fields.highestTransactionId ?? 0n;
  const connected = fields.isConnected ?? false;
  // Once the indexer has told the wallet its max event id, we can
  // render a real progress percentage. Until then surface "applied,
  // highest unknown" and the subscription's connection state so the
  // user can tell "still connecting" from "connected but no events yet"
  // from "events flowing".
  if (highest === 0n) {
    return `applied=${applied} highest=? connected=${connected} complete=${complete}`;
  }
  const pct = Number((applied * 100n) / highest);
  return `${applied}/${highest} (${pct}%) connected=${connected} complete=${complete}`;
}

export interface SyncAndVerifyFundsArgs {
  wallet: MidnightWalletProvider;
  timeoutMs: number;
  logger: Logger;
  /** Periodic checkpoint so a Ctrl+C mid-sync survives. Owned-wallet branch only. */
  onCheckpoint?: () => Promise<void>;
}

/**
 * Drive the wallet to chain tip and assert spendable funds. Gates on each
 * sub-wallet being within {@link SYNC_MAX_GAP} events of the tip rather
 * than strictly complete: on a live network the global dust stream never
 * settles to gap 0, so strict `FacadeState.isSynced` never fires and the
 * gate times out on a perfectly usable wallet (#115). The gate still waits
 * on all three sub-wallets; dropping the dust/shielded wait entirely
 * regressed on local with `Invalid Transaction (custom error 170)`.
 * Throttles progress logs to once per 30 s. Throws
 * {@link UnfundedWalletError} on empty wallet.
 */
export async function syncAndVerifyFunds(
  args: SyncAndVerifyFundsArgs,
): Promise<void> {
  const { wallet, timeoutMs, logger, onCheckpoint } = args;
  logger.info(
    `Syncing wallet to chain tip (timeout ${Math.round(timeoutMs / 1000)}s)…`,
  );
  const start = Date.now();

  // Two subscriptions to the same observable: one logs throttled
  // progress lines for UX, the other waits for completion. The progress
  // tap deliberately runs through `Rx.throttleTime(30_000)` so the
  // shielded-sync flood doesn't drown the terminal; the completion gate
  // doesn't throttle, so the deploy proceeds the instant sync flips.
  const state$ = wallet.wallet.state();
  const progressSub = state$
    .pipe(
      Rx.throttleTime(30_000, undefined, { leading: false, trailing: true }),
    )
    .subscribe((s) => {
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      const elapsedHms =
        elapsedSec < 60
          ? `${elapsedSec}s`
          : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
      // Pull running balance projections each tick so the user can
      // see funds materialise mid-sync (NIGHT becomes visible the
      // moment unshielded completes; dust accumulates as the wallet
      // processes events even before its sync is strictly complete).
      const shieldedBal = s.shielded.balances[shieldedToken().raw] ?? 0n;
      const unshieldedBal = s.unshielded.balances[unshieldedToken().raw] ?? 0n;
      const dustBal = s.dust.balance(new Date());
      logger.info(
        `Still syncing (${elapsedHms} elapsed). ` +
          `shielded ${describeProgress(s.shielded.state.progress)} balance=${shieldedBal}; ` +
          `unshielded ${describeProgress(s.unshielded.progress)} balance=${unshieldedBal}; ` +
          `dust ${describeProgress(s.dust.state.progress)} balance=${dustBal}`,
      );
    });

  // Periodic checkpoint: snapshot the wallet caches every 5 min so a
  // user who Ctrl+C's a long preprod first-run can resume from the
  // latest snapshot instead of starting at id=0 again. Best-effort:
  // a failed save logs a warning and the sync keeps going. Skipped
  // when `onCheckpoint` is not provided (i.e. injected-wallet callers
  // where the deployer doesn't own persistence).
  let checkpointInFlight = false;
  const checkpointSub = onCheckpoint
    ? state$
        .pipe(
          Rx.throttleTime(5 * 60 * 1000, undefined, {
            leading: false,
            trailing: true,
          }),
        )
        .subscribe(() => {
          if (checkpointInFlight) return;
          checkpointInFlight = true;
          onCheckpoint()
            .catch((e: unknown) => {
              logger.warn(
                { err: (e as Error).message },
                'Wallet cache checkpoint failed; continuing sync',
              );
            })
            .finally(() => {
              checkpointInFlight = false;
            });
        })
    : undefined;

  // Per-sub-wallet edge-trigger: the first time each sub-wallet flips
  // to `complete=true`, log its current balance immediately. This lets
  // a user with NIGHT+dust (the typical preprod-faucet wallet shape)
  // see their unshielded balance after ~30 s instead of waiting for
  // the full shielded sync (30 – 60 min) to surface anything.
  const seenComplete = { shielded: false, unshielded: false, dust: false };
  const balanceSub = state$.subscribe((s) => {
    if (
      !seenComplete.unshielded &&
      s.unshielded.progress.isStrictlyComplete()
    ) {
      seenComplete.unshielded = true;
      const bal = s.unshielded.balances[unshieldedToken().raw] ?? 0n;
      logger.info(`Unshielded sync complete — NIGHT balance: ${bal}`);
    }
    if (!seenComplete.dust && s.dust.state.progress.isStrictlyComplete()) {
      seenComplete.dust = true;
      const bal = s.dust.balance(new Date());
      logger.info(`Dust sync complete — dust balance: ${bal}`);
    }
    if (
      !seenComplete.shielded &&
      s.shielded.state.progress.isStrictlyComplete()
    ) {
      seenComplete.shielded = true;
      const bal = s.shielded.balances[shieldedToken().raw] ?? 0n;
      logger.info(`Shielded sync complete — shielded balance: ${bal}`);
    }
  });

  let synced: FacadeState;
  try {
    synced = await Rx.firstValueFrom(
      state$.pipe(
        // Tolerant tip gate: all three sub-wallets within SYNC_MAX_GAP
        // events of the tip. Strict `s.isSynced` never fires on a live
        // chain because the global dust stream keeps advancing (#115).
        Rx.filter(
          (s: FacadeState) =>
            s.shielded.state.progress.isCompleteWithin(SYNC_MAX_GAP) &&
            s.dust.state.progress.isCompleteWithin(SYNC_MAX_GAP) &&
            s.unshielded.progress.isCompleteWithin(SYNC_MAX_GAP),
        ),
        Rx.timeout({
          each: timeoutMs,
          with: () =>
            Rx.throwError(
              () => new Error(`Wallet sync timeout after ${timeoutMs}ms`),
            ),
        }),
      ),
    );
  } finally {
    progressSub.unsubscribe();
    balanceSub.unsubscribe();
    checkpointSub?.unsubscribe();
  }

  const totalSec = Math.round((Date.now() - start) / 1000);
  const totalHms =
    totalSec < 60
      ? `${totalSec}s`
      : `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
  logger.info(`Sync complete after ${totalHms}`);

  // Accept funds in either shielded or unshielded. Preprod faucets
  // hand out unshielded NIGHT, while a freshly bridged wallet may sit
  // entirely in the shielded layer. Both are deployable: dust for
  // fees auto-generates from either NIGHT or shielded holdings.
  // Mirrors midnight-apps's `waitForUnshieldedFunds` semantics.
  const shieldedBal = synced.shielded.balances[shieldedToken().raw];
  const unshieldedBal = synced.unshielded.balances[unshieldedToken().raw];
  const hasShielded = shieldedBal !== undefined && shieldedBal > 0n;
  const hasUnshielded = unshieldedBal !== undefined && unshieldedBal > 0n;
  if (!hasShielded && !hasUnshielded) {
    throw new UnfundedWalletError(wallet.getCoinPublicKey());
  }
  logger.info(
    `Wallet balance: shielded=${shieldedBal ?? 0n}, unshielded=${unshieldedBal ?? 0n}`,
  );
}
