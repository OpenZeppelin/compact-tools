/**
 * Type-level regression guard for the static `create` / `_create` contract.
 *
 * `yarn types` compiles `src/**` but NOT `test/**` (the sample simulators import
 * generated, gitignored contract artifacts), and `vitest` strips types without
 * checking them — so a regression in the `create` / `_create` typing would
 * otherwise pass CI. This file reproduces the subclass-override pattern against a
 * synthetic contract type, so `yarn types` fails on a regression.
 *
 * It exports nothing and is imported by nothing (inert at runtime). The build
 * config (`tsconfig.json`) excludes `*.type-test.ts` from emit, so it never
 * reaches `dist`; the type check runs it via `tsconfig.types.json`.
 *
 * Typechecking the real test simulators (which need the generated artifacts) is a
 * separate, larger effort; this is the minimal guard for the contract that
 * actually regressed.
 */
import { createSimulator } from './factory/createSimulator.js';
import type { SimulatorConfig } from './factory/SimulatorConfig.js';
import type { IMinimalContract } from './types/Contract.js';

type GuardPrivateState = { readonly value: number };
type GuardArgs = readonly [a: number, b: string];

// A synthetic config — never executed, only used to instantiate the factory's
// generics for the type-level checks below.
const config = {} as unknown as SimulatorConfig<
  GuardPrivateState,
  unknown,
  unknown,
  IMinimalContract,
  GuardArgs
>;

class Guard extends createSimulator(config) {
  // A concrete `Promise<Guard>` return must stay assignable to the base static
  // side. If `create`'s return goes generic again, this fails the static-side
  // `extends` check (TS2417).
  static async create(a: number, b: string, options = {}): Promise<Guard> {
    // biome-ignore lint/complexity/noThisInStatic: super._create must keep the subclass `this`
    return super._create([a, b], options) as Promise<Guard>;
  }

  // `_create` must type its args tuple against `GuardArgs`. If that check
  // regresses (e.g. `_create` widens to `...args: unknown[]`), the wrong-arity
  // call below stops erroring and the `@ts-expect-error` becomes unused → CI red.
  static async _argCheck(): Promise<unknown> {
    // Call via the class name (not `super`) so this negative assertion needs
    // only the `@ts-expect-error` below — no `noThisInStatic` ignore to stack.
    // @ts-expect-error a 1-element tuple must not satisfy `[number, string]`.
    return Guard._create([1], {});
  }

  // A subclass-only member. Without it, `Guard`'s instance type would equal the
  // base `Simulator`'s and the call-site check below would pass even if `create`
  // stopped narrowing to the subclass. This mirrors real subclasses, which add
  // circuit methods that a base-typed return would hide.
  public marker(): string {
    return 'guard';
  }
}

// The override must narrow the call-site return to the subclass, not widen to
// the base `Simulator` (which lacks `marker`).
async function _callSiteSubtype(): Promise<void> {
  const instance: Guard = await Guard.create(1, 'x');
  void instance.marker();
}

void Guard;
void _callSiteSubtype;
