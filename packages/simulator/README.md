# OpenZeppelin Compact Simulator

OpenZeppelin Compact Simulator provides a testing and development environment for Compact contracts on the Midnight network,
allowing you to simulate contract behavior locally without blockchain deployment.

## Features

- 🧪 **Local Testing** - Test contracts without deployment.
- 🔧 **Witness Overrides** - Mock and spy on witness functions.
- 📊 **State Inspection** - Access private and contract state.
- 🚀 **Type-Safe** - Full TypeScript support with generics.
- 🔀 **Two Backends** - The same spec runs in memory (`dry`) or against a node (`live`), selected by `MIDNIGHT_BACKEND`.

> **Upgrading from 0.3.x?** Construction and every circuit call are now
> asynchronous. See the [changelog](https://github.com/OpenZeppelin/compact-tools/blob/main/packages/simulator/CHANGELOG.md).

## Quick Start

```typescript
import { createSimulator, type SimulatorOptions } from '@openzeppelin/compact-simulator';
import { Contract, ledger } from './artifacts/MyContract/contract/index.js';

// 1. Define your contract's constructor arguments as a tuple type
type MyContractArgs = readonly [owner: Uint8Array, value: bigint];

// 2. Create the simulator class
const MySimulatorBase = createSimulator<
  MyPrivateState,                     // Private state
  ReturnType<typeof ledger>,          // Ledger state
  ReturnType<typeof MyWitnesses>,     // Witnesses
  Contract<MyPrivateState>,           // Contract
  MyContractArgs                      // Constructor args
>({
  contractFactory: (witnesses) => new Contract<MyPrivateState>(witnesses),
  defaultPrivateState: () => MyPrivateState.generate(),
  contractArgs: (owner, value) => [owner, value],
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => MyWitnesses(),
});

// 3. Use it!
const sim = await MySimulatorBase.create([ownerAddress, 100n], { coinPK: deployerPK });
```

## Core Concepts

### 1. Creating a Base Simulator

The base simulator acts as a configuration class that the actual simulator will extend:

```typescript
import { createSimulator } from '@openzeppelin/compact-simulator';
import { Contract as MyContract, ledger } from './artifacts/MyContract/contract/index.js';
import { MyContractWitnesses, MyContractPrivateState } from './MyContractWitnesses.js';

// Define contract constructor arguments as a tuple type
type MyContractArgs = readonly [arg1: bigint, arg2: string];

// Create the base simulator with full type information
const MyContractSimulatorBase = createSimulator<
  MyContractPrivateState,                       // Private state type
  ReturnType<typeof ledger>,                    // Ledger state type
  ReturnType<typeof MyContractWitnesses>,       // Witnesses type
  MyContract<MyContractPrivateState>,           // Contract type
  MyContractArgs                                // Constructor args type
>({
  contractFactory: (witnesses) => new MyContract<MyContractPrivateState>(witnesses),
  defaultPrivateState: () => MyContractPrivateState.generate(),
  contractArgs: (arg1, arg2) => [arg1, arg2],
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => MyContractWitnesses(),  // Note: Must be a function!
});
```

The fourth type parameter is the **contract**, not the args tuple. The args
tuple is the fifth and defaults to `readonly any[]`; pass it explicitly so a
wrong tuple is caught at the `create` call.

### ⚠️ Witness Factory Pattern

The simulator requires `witnessesFactory` to be a function that returns witnesses, even for empty witnesses.
If the Compact contract has no witnesses:

```typescript
// Some Compact contract examples use:
export const MyContractWitnesses = {};

// But for the simulator, wrap it in a function:
export const MyContractWitnesses = () => ({});
```

This is required because the simulator API expects a factory function for consistency.

### 2. Extending the Base Simulator

Create your simulator class with a user-friendly API by overriding the static
`create`:

```typescript
export class MyContractSimulator extends MyContractSimulatorBase {
  // Override `create` and return your own type. The base `create` returns the
  // base `Simulator` (it can't be generic without breaking these overrides), so
  // without this a `MyContractSimulator.create(...)` call would resolve to
  // `Simulator` and lose the methods below. Delegate to `super._create`, which is
  // typed against the contract's constructor args, so a wrong tuple is caught.
  static async create(
    arg1: bigint,
    arg2: string,
    options: SimulatorOptions<
      MyContractPrivateState,
      ReturnType<typeof MyContractWitnesses>
    > = {},
  ): Promise<MyContractSimulator> {
    return super._create([arg1, arg2], options) as Promise<MyContractSimulator>;
  }

  // Wrap the contract's circuits with callable methods. Every circuit call is
  // async. It returns a promise, so callers `await` it.
  public getValue(): Promise<bigint> {
    return this.circuits.impure.getValue();
  }

  public setValue(val: bigint): Promise<[]> {
    return this.circuits.impure.setValue(val);
  }

  public transfer(to: Uint8Array, amount: bigint): Promise<[]> {
    return this.circuits.impure.transfer(to, amount);
  }
}
```

> **Every subclass must override the static `create`** and return its own type
> (e.g. `Promise<MyContractSimulator>`), delegating to
> `super._create([...args], options)`. This applies even to subclasses that only
> add circuit methods without the override, `MyContractSimulator.create(...)`
> resolves to the base `Simulator` type and callers lose the subclass's methods.

There is no public constructor. `create` resolves the backend (including the
live adapter's dynamic import) and runs the contract constructor, both of which
are async, so `new MyContractSimulator(...)` is not a supported entry point.

### 3. Circuit Types

Every circuit proxy returns a promise on both backends, so a single spec runs
against either with uniform `await`.

#### Pure Circuits

Compute outputs from inputs without reading or modifying state. They run
locally on the JS artifact in both modes:

```typescript
public add(a: bigint, b: bigint): Promise<bigint> {
  return this.circuits.pure.add(a, b);
}

public calculateFee(amount: bigint): Promise<bigint> {
  return this.circuits.pure.calculateFee(amount);
}
```

#### Impure Circuits

Read and/or modify the contract state. In live mode they submit a transaction,
so a read implemented as an impure circuit still hits the node:

```typescript
public deposit(amount: bigint): Promise<[]> {
  return this.circuits.impure.deposit(amount);
}

public getBalance(): Promise<bigint> {
  return this.circuits.impure.getBalance();
}
```

## Advanced Features

### 👤 Callers and Signers

Callers are named by alias. Dry derives a deterministic key per alias; live
resolves the alias against the harness's prefunded wallet pool.

```typescript
// Next call only, then reverts to the default signer
await simulator.as('OWNER').transferOwnership(newOwnerId);

// Until changed
simulator.setPersistentCaller('ALICE');
simulator.resetCaller();

// Resolve an alias for use as a circuit argument
const owner = await simulator.signers.eitherFor('OWNER');
```

> `ownPublicKey()` is a witness value and MUST NOT be used as an authentication
> mechanism. These helpers exist for circuits that take the caller as an input
> to other computations (e.g. commitment derivation).

### 🔧 Witness Overrides

Perfect for testing edge cases and tracking witness usage. Dry only: the live
backend throws, because witnesses bind at deploy.

```typescript
// Override with fixed value for deterministic testing
const fixedNonce = new Uint8Array(32).fill(42);
simulator.overrideWitness('secretNonce', (context) => {
  return [context.privateState, fixedNonce];
});

// Track witness calls
let callCount = 0;
simulator.overrideWitness('secretValue', (context) => {
  callCount++;
  return [context.privateState, context.privateState.secretValue];
});

await simulator.someOperation();
console.log(`Witness called ${callCount} times`);

// Test error conditions
simulator.overrideWitness('requiredValue', (context) => {
  return [context.privateState, null]; // Return invalid data
});
```

### 📊 State Inspection

Every getter is async, so dry reads in memory and live reads through the
indexer behind the same call:

```typescript
// Get private state
const privateState = await simulator.getPrivateState();
console.log('Secret value:', privateState.secretValue);

// Get public ledger state
const ledgerState = await simulator.getPublicState();
console.log('Public state:', ledgerState);

// Get the raw contract state value
const contractState = await simulator.getContractState();

// The deployed address, e.g. to rebuild a digest bound to `kernel.self()`
console.log('Address:', simulator.contractAddress);
```

Private state can also be replaced or patched:

```typescript
await simulator.setPrivateState(nextState);
await simulator.updatePrivateState({ secretNonce });
await simulator.updatePrivateState((prev) => ({ ...prev, counter: prev.counter + 1n }));
```

## Testing Examples

### Basic Test Structure

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { MyContractSimulator } from './MyContractSimulator.js';

let simulator: MyContractSimulator;
const val = 123n;
const newVal = 456n;

describe('MyContract', () => {
  beforeEach(async () => {
    simulator = await MyContractSimulator.create(val);
  });

  it('sets new value', async () => {
    await simulator.setVal(newVal);
    expect((await simulator.getPublicState())._val).toEqual(newVal);
  });
});
```

### Testing with Witness Overrides

```typescript
it('handles custom witness behavior', async () => {
  const customValue = new Uint8Array(32).fill(99);
  let wasCalled = false;

  simulator.overrideWitness('secretValue', (context) => {
    wasCalled = true;
    return [context.privateState, customValue];
  });

  await simulator.performOperation();

  expect(wasCalled).toBe(true);
});
```

## Special Cases

### Contracts with No Constructor Arguments

```typescript
// Define empty args type
type NoArgs = readonly [];

const SimpleSimulatorBase = createSimulator<
  SimplePrivateState,
  ReturnType<typeof ledger>,
  ReturnType<typeof SimpleWitnesses>,
  SimpleContract<SimplePrivateState>,
  NoArgs  // Empty tuple for no arguments
>({
  contractFactory: (witnesses) => new SimpleContract<SimplePrivateState>(witnesses),
  defaultPrivateState: () => SimplePrivateState.generate(),
  contractArgs: () => [],  // Return empty array
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => SimpleWitnesses(),
});

export class SimpleSimulator extends SimpleSimulatorBase {
  static async create(
    options: SimulatorOptions<
      SimplePrivateState,
      ReturnType<typeof SimpleWitnesses>
    > = {},
  ): Promise<SimpleSimulator> {
    return super._create([], options) as Promise<SimpleSimulator>;  // Pass empty array
  }
}
```

## API Reference

### SimulatorOptions

```typescript
interface BaseSimulatorOptions<P, W> {
  privateState?: P;                   // Initial private state
  witnesses?: W;                      // Custom witness implementations
  coinPK?: CoinPublicKey;             // Coin public key (default: '0'.repeat(64))
  contractAddress?: ContractAddress;  // Contract address (dry default: dummyContractAddress())
  time?: number;                      // Block time the kernel observes, in seconds (default: 0)
}

interface SimulatorOptions<P, W> extends BaseSimulatorOptions<P, W> {
  backend?: BackendKind;              // Pin 'dry' | 'live' instead of reading MIDNIGHT_BACKEND
  live?: LiveContext<P>;              // Live only: the caller's live world
  signerKeys?: Readonly<Record<string, CoinPublicKey>>;  // Dry only: override alias to key derivation
  liveAliases?: readonly string[];    // Live only: the prefunded alias pool
  resolveLiveKey?: (alias: string) => CoinPublicKey | Promise<CoinPublicKey>;
}
```

`time` defaults to `0` so runs are reproducible; the runtime would otherwise
stamp wall-clock time.

In live mode the address comes from the deployed contract. An explicit
`contractAddress` that does not match it is rejected, so pure circuits reading
`kernel.self()` always observe the deployed address.

### Core Methods

| Method | Description |
| ------ | ----------- |
| `static create(...args, options?)` | Construct a simulator (async; overridden per subclass) |
| `contractAddress` | The deployed contract's address |
| `signers` | Alias resolver (`keyFor`, `eitherFor`) for circuit arguments |
| `as(alias)` | Set the caller for the next call only |
| `setPersistentCaller(alias)` / `resetCaller()` | Set or clear the caller for all subsequent calls |
| `getPrivateState()` | Get current private state (async) |
| `setPrivateState(state)` / `updatePrivateState(patch \| fn)` | Replace or patch the private state (async) |
| `getPublicState()` | Get current public ledger state (async) |
| `getContractState()` | Get the raw contract state value (async) |
| `overrideWitness(key, fn)` / `setWitnesses(w)` | Replace witnesses (dry only; live throws) |

## Tips & Best Practices

1. **Type Safety**: Always specify generic parameters, including the args tuple, for full type safety.
2. **Await Everything**: Construction, circuit calls, and state reads are all async.
3. **Witness Testing**: Use witness overrides to test edge cases without modifying contract code.
4. **Deterministic Tests**: Override witnesses with fixed values and leave `time` at its default for reproducible tests.
5. **State Validation**: Inspect state after operations to ensure correctness.
