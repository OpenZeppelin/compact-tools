import type { SimulatorConfig } from '../factory/SimulatorConfig.js';
import type { IMinimalContract } from '../types/Contract.js';
import type { SimulatorOptions } from '../types/Options.js';
import type { LiveContext } from './LiveContext.js';

/**
 * What the registered live backend receives in order to deploy/attach the right
 * contract and return a {@link LiveContext} for it. The harness owns all infra;
 * this just hands it the same config + args the test used.
 */
export interface LiveBackendRequest<
  P = unknown,
  L = unknown,
  W = unknown,
  TContract extends IMinimalContract = IMinimalContract,
  TArgs extends readonly unknown[] = readonly unknown[],
> {
  /** The simulator config (contract factory, witnesses, ledger extractor, …). */
  config: SimulatorConfig<P, L, W, TContract, TArgs>;
  /** The constructor args the test passed to `create`. */
  contractArgs: TArgs;
  /** The options the test passed to `create`. */
  options: SimulatorOptions<P, W>;
}

/**
 * Produces a {@link LiveContext} for a given request. Registered once by the
 * consuming harness (typically in a `test:live` setup file).
 */
export type LiveBackendFactory = (
  // The registry is contract-agnostic; each call is concretely typed at the create() site.
  req: LiveBackendRequest<any, any, any, any, any>,
) => Promise<LiveContext<unknown>>;

let registeredFactory: LiveBackendFactory | undefined;

/**
 * Registers the live backend the simulator attaches to when
 * `MIDNIGHT_BACKEND=live` and no explicit `{ live }` is passed to `create`.
 *
 * Call this once from your `test:live` setup. It keeps the per-module test files
 * backend-agnostic: `await Sim.create()` works on both backends.
 *
 * @param factory - Builds a {@link LiveContext} per `create` call.
 */
export function registerLiveBackend(factory: LiveBackendFactory): void {
  registeredFactory = factory;
}

/** Clears the registered live backend (mainly for test teardown). */
export function clearLiveBackend(): void {
  registeredFactory = undefined;
}

/** Returns the registered live backend factory, if any. */
export function getRegisteredLiveBackend(): LiveBackendFactory | undefined {
  return registeredFactory;
}

/**
 * Whether the live backend is selected via `MIDNIGHT_BACKEND=live`.
 *
 * Use it in specs to guard the documented dry↔live asymmetries, e.g.
 * `it.skipIf(isLiveBackend())('rejects witness override', …)`.
 */
export function isLiveBackend(): boolean {
  return process.env.MIDNIGHT_BACKEND === 'live';
}
