# OpenZeppelin Compact Simulator

OpenZeppelin Compact Simulator provides a testing and development environment for Compact contracts on the Midnight network,
allowing you to simulate contract behavior locally without blockchain deployment.

## Features

- 🧪 **Local Testing** - Test contracts without deployment.
- 🔧 **Witness Overrides** - Mock and spy on witness functions.
- 📊 **State Inspection** - Access private and contract state.
- 🚀 **Type-Safe** - Full TypeScript support with generics.

## Quick Start

```typescript
import { createSimulator } from '@openzeppelin-compact/contracts-simulator';
import { Contract, ledger } from './artifacts/MyContract/contract/index.js';

// 1. Define your contract arguments type
type MyContractArgs = readonly [owner: Uint8Array, value: bigint];

// 2. Create the simulator
const MySimulator = createSimulator<
  MyPrivateState,
  ReturnType<typeof ledger>,
  ReturnType<typeof MyWitnesses>,
  MyContractArgs
>({
  contractFactory: (witnesses) => new Contract<MyPrivateState>(witnesses),
  defaultPrivateState: () => MyPrivateState.generate(),
  contractArgs: (owner, value) => [owner, value],
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => MyWitnesses(),
});

// 3. Use it!
const sim = new MySimulator([ownerAddress, 100n], { coinPK: deployerPK });
```

## Core Concepts

### 1. Creating a Base Simulator

The base simulator acts as a configuration class that the actual simulator will extend:

```typescript
import { createSimulator } from '@openzeppelin-compact/contracts-simulator';
import { Contract as MyContract, ledger } from './artifacts/MyContract/contract/index.js';
import { MyContractWitnesses, MyContractPrivateState } from './MyContractWitnesses.js';

// Define contract constructor arguments as a tuple type
type MyContractArgs = readonly [arg1: bigint, arg2: string];

// Create the base simulator with full type information
const MyContractSimulatorBase = createSimulator<
  MyContractPrivateState,                    // Private state type
  ReturnType<typeof ledger>,                 // Ledger state type
  ReturnType<typeof MyContractWitnesses>,    // Witnesses type
  MyContractArgs                             // Constructor args type
>({
  contractFactory: (witnesses) => new MyContract<MyContractPrivateState>(witnesses),
  defaultPrivateState: () => MyContractPrivateState.generate(),
  contractArgs: (arg1, arg2) => [arg1, arg2],
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => MyContractWitnesses(),  // Note: Must be a function!
});
```

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

Create your simulator class with a user-friendly API:

```typescript
export class MyContractSimulator extends MyContractSimulatorBase {
  constructor(
    arg1: bigint,
    arg2: string,
    options: BaseSimulatorOptions<
      MyContractPrivateState,
      ReturnType<typeof MyContractWitnesses>
    > = {}
  ) {
    // Bundle args into tuple for parent class
    super([arg1, arg2], options);
  }

  // Wrap contract's circuits with callable methods
  public getValue(): bigint {
    return this.circuits.impure.getValue();
  }

  public setValue(val: bigint): void {
    this.circuits.impure.setValue(val);
  }

  public transfer(to: Uint8Array, amount: bigint): void {
    this.circuits.impure.transfer(to, amount);
  }
}
```

### 3. Circuit Types

#### Pure Circuits

Compute outputs from inputs without reading or modifying state:

```typescript
public add(a: bigint, b: bigint): bigint {
  return this.circuits.pure.add(a, b);
}

public calculateFee(amount: bigint): bigint {
  return this.circuits.pure.calculateFee(amount);
}
```

#### Impure Circuits

Read and/or modify the contract state:

```typescript
public deposit(amount: bigint): void {
  this.circuits.impure.deposit(amount);
}

public getBalance(): bigint {
  return this.circuits.impure.getBalance();
}
```

## Advanced Features

### 🔧 Witness Overrides

Perfect for testing edge cases and tracking witness usage:

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

simulator.someOperation();
console.log(`Witness called ${callCount} times`);

// Test error conditions
simulator.overrideWitness('requiredValue', (context) => {
  return [context.privateState, null]; // Return invalid data
});
```

### 📊 State Inspection

Access various levels of contract state:

```typescript
// Get private state
const privateState = simulator.getPrivateState();
console.log('Secret value:', privateState.secretValue);

// Get public ledger state
const ledgerState = simulator.getPublicState();
console.log('Public state:', ledgerState);

// Get full contract state
const contractState = simulator.getContractState();

// Access complete circuit context
const context = simulator.circuitContext;
console.log('Zswap inputs', context.currentZswapLocalState.inputs);
```

## Testing Examples

### Basic Test Structure

```typescript
import { encodeCoinPublicKey } from '@midnight-ntwrk/compact-runtime';
import { describe, it, expect, beforeEach } from 'vitest';
import { MyContractSimulator } from './MyContractSimulator';

let simulator: MyContractSimulator;
let val = 123n;
let newVal = 456n;

describe('MyContract', () => {
  beforeEach(() => {
    simulator = new MyContractSimulator(val);
  });

  it('should set new value', () => {
    simulator.setVal(newVal);
    expect(simulator.getPublicState()._val).toEqual(newVal);
  });
});
```

### Testing with Witness Overrides

```typescript
it('should handle custom witness behavior', () => {
  const customValue = new Uint8Array(32).fill(99);
  let wasCalled = false;

  simulator.overrideWitness('secretValue', (context) => {
    wasCalled = true;
    return [context.privateState, customValue];
  });

  simulator.performOperation();

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
  NoArgs  // Empty tuple for no arguments
>({
  contractFactory: (witnesses) => new SimpleContract<SimplePrivateState>(witnesses),
  defaultPrivateState: () => SimplePrivateState.generate(),
  contractArgs: () => [],  // Return empty array
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => SimpleWitnesses(),
});

export class SimpleSimulator extends SimpleSimulatorBase {
  constructor(options: BaseSimulatorOptions<...> = {}) {
    super([], options);  // Pass empty array
  }
}
```

## API Reference

### BaseSimulatorOptions

```typescript
interface BaseSimulatorOptions<P, W> {
  privateState?: P;                   // Initial private state
  witnesses?: W;                      // Custom witness implementations
  coinPK?: CoinPublicKey;             // Coin public key (default: '0'.repeat(64))
  contractAddress?: ContractAddress;  // Contract address (default: sampleContractAddress())
}
```

### Core Methods

| Method | Description |
| ------ | ----------- |
| `overrideWitness(key, fn)` | Override a specific witness function |
| `getPrivateState()` | Get current private state |
| `getPublicState()` | Get current public ledger state |
| `getContractState()` | Get full contract state |

## Tips & Best Practices

1. **Type Safety**: Always specify generic parameters for full type safety.
2. **Witness Testing**: Use witness overrides to test edge cases without modifying contract code.
3. **Deterministic Tests**: Override witnesses with fixed values for reproducible tests.
4. **State Validation**: Inspect state after operations to ensure correctness.
