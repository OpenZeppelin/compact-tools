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

For a compiled contract module, [`defineSimulator`](#5-defining-a-simulator-from-the-artifact)
needs none of the steps below. They show the underlying `createSimulator`.

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

### 4. Flat Circuit Methods

Every instance also has one async method per circuit, named after it:
`await sim.setValue(5n)` calls `sim.circuits.impure.setValue(5n)`. Each call reads
`circuits` afresh, so witness overrides apply. The methods exist on every class.
`flatCircuits: true` in the config types them, so a subclass needs no forwarding
methods.

Before, as in step 2, one forwarding method per circuit:

```typescript
export class MyContractSimulator extends MyContractSimulatorBase {
  static async create(/* ... */): Promise<MyContractSimulator> { /* ... */ }

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

After, with the flag and no forwards:

```typescript
const MyContractSimulatorBase = createSimulator<
  MyContractPrivateState,
  ReturnType<typeof ledger>,
  ReturnType<typeof MyContractWitnesses>,
  MyContract<MyContractPrivateState>,
  MyContractArgs
>({
  contractFactory: (witnesses) => new MyContract<MyContractPrivateState>(witnesses),
  defaultPrivateState: () => MyContractPrivateState.generate(),
  contractArgs: (arg1, arg2) => [arg1, arg2],
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => MyContractWitnesses(),
  flatCircuits: true,
});

export class MyContractSimulator extends MyContractSimulatorBase {
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
}

const sim = await MyContractSimulator.create(1n, 'a');
await sim.setValue(5n);
const value = await sim.getValue(); // 5n
```

Which circuits get a method:

- A name the instance already has when the base constructor runs is skipped: base
  members (`getPublicState`, `signers`, `as`), subclass methods and accessors, and
  `Object.prototype` names (`toString`, `constructor`).
- `then` is never installed. It would make the instance thenable, so
  `await create()` would call it.
- A skipped circuit stays reachable through `sim.circuits.impure` or
  `sim.circuits.pure`.
- A subclass field of the same name replaces the method after `super()`.
- The methods are non-enumerable, so spreads, `Object.keys` and JSON are unchanged.

Typing with `flatCircuits: true`:

- Base member names, `Object.prototype` names and `then` keep their own type, or none.
- A subclass method named like a circuit fails with TS2425. Override it with a field
  instead, with a type compatible with the circuit's:
  `public readonly getValue = async (): Promise<bigint> => 42n;`. Or leave that class
  without the flag.
- The flag must reach `createSimulator` as the literal `true`. In a config declared
  earlier it widens to `boolean`, the untyped overload is picked, and the error shows
  up only at the first circuit call (TS2339). Write it at the call
  (`createSimulator({ ...config, flatCircuits: true })`), or declare it
  `flatCircuits: true as const`.

### 5. Defining a Simulator from the Artifact

`defineSimulator(artifact, definition?)` builds the simulator class from the
compiled contract module. No config generics, no `create` override, no
forwarding methods. A spec defines its simulator in one statement:

```typescript
import { defineSimulator } from '@openzeppelin/compact-simulator';
import * as MockOwnable from '../artifacts/MockOwnable/contract/index.js';
import {
  OwnableHelpers,
  OwnablePrivateState,
  OwnableWitnesses,
} from './witnesses/OwnableWitnesses.js';

class OwnableSimulator extends defineSimulator(MockOwnable, {
  witnesses: OwnableWitnesses,
  privateState: OwnablePrivateState.generate,
  extend: OwnableHelpers,
  artifactName: 'MockOwnable',
}) {}

const sim = await OwnableSimulator.create(owner, true, { privateState });
await sim.transferOwnership(newOwner);
await sim.privateState.injectSecretKey(otherKey);
```

The class reads from the artifact:

- `Contract` and `ledger`: the contract factory and the ledger extractor.
- The constructor arity, from the compiled `initialState`, which checks its
  argument count first. When it cannot be read, `defineSimulator` throws; pass
  `arity` instead. Code rewritten before it loads, e.g. by an istanbul-style
  coverage instrumenter or a minifier, no longer matches: pass `arity` there too.
  V8 coverage leaves the code as compiled.
- The contract's witness type. The definition's witnesses are checked against
  it, with the private state the definition yields (see the table below).
- `pureCircuits`: each pure circuit is also a synchronous static method
  (`OwnableSimulator.hash(x)`). A name the class already has (`name`, `length`,
  `create`, `Object.prototype` names) or `then` is skipped.

Every circuit is an async instance method, as with `flatCircuits: true`.

`create` takes the constructor arguments positionally, then an optional options
object: `create(owner, true)` or `create(owner, true, { privateState })`. Any
other argument count throws, and so does a value in the options slot that is
not an options object or `undefined` (`create(owner, true, 5n)`). The count
alone decides, so a struct as the last constructor argument is never read as
options. It resolves to the calling class. The tuple form
`_create([owner, true], options)` still works, except on a class with `prepare`.

A subclass cannot override `create` with its own signature: TypeScript rejects
it (TS2417). Write the signature as `prepare` instead.

Definition fields, all optional:

| Field | Default | Purpose |
| --- | --- | --- |
| `witnesses` | no witnesses | Witness factory, or a list of factories merged into one. Required when the contract declares witnesses, unless `prepare` supplies them. |
| `privateState` | `{}` | Factory for the initial private state, or a list merged into one. |
| `extend` | none | `(sim) => members`. Added to every instance: helper bags, wrappers, sync versions of circuits. A member replaces the circuit method of the same name. Getters stay getters. |
| `prepare` | positional `create` | `(...input) => ({ args, options?, fields? })`. `create` takes `prepare`'s parameters; `fields` become own fields of the instance. Without definition `witnesses`, a contract with witnesses needs `options.witnesses`. The class has no `_create`. |
| `artifactName` | none | The `artifacts/<name>/` directory the live backend deploys. |
| `arity` | read from the artifact | The constructor's argument count. |

The witnesses must match the contract's `Witnesses<P>`, where `P` is the private
state the definition yields. A missing witness, a wrong value type, or a witness
that reads a private state the factories do not make fails to compile. The
witnesses `prepare` or `create` passes in options are checked the same way.
With a list of parts, `sim.witnesses` and the options take the contract's
`Witnesses<P>` type; a single factory keeps its own type.

`extend` and `fields` cannot take a name the simulator itself uses: a base
member (`getPrivateState`, `circuits`, `signers`, `witnesses`, ...), an
`Object.prototype` name, or `then`. Such a name throws at `create`.

The live backend receives a full `SimulatorConfig`: identity `contractArgs`,
the witness and private-state factories (merged), and `artifactName`.

#### Witnesses and private state from parts

A mock that pairs a module with an authenticator needs both parts' witnesses and
a private state holding both. List the parts instead of writing a bundled
factory. Here `TokenWitnesses` and `TokenPrivateState` hold the module's own
witnesses and keys only, and the authenticator owns `secretKey`:

```typescript
class TokenSimulator extends defineSimulator(MockToken, {
  witnesses: [TokenWitnesses, AuthPrfPseudonymWitnesses],
  privateState: [TokenPrivateState.generate, AuthPrfPseudonymPrivateState.generate],
}) {}
// getPrivateState(): Promise<TokenPrivateState & AuthPrfPseudonymPrivateState>
```

- Each witness receives the whole merged private state. A part's witness may
  return only its own part, typed on its own state
  (`[{ ...privateState, nonce }, value]`). The merged witness writes that part
  over the whole state, so the other parts' keys stay.
- A part may return a class instance. Its prototype methods are kept and called
  on it. A private-state part returns a plain object.
- A witness name or private-state key that two parts define throws when the
  definition runs, also if `prepare` or `create` supplies the witnesses or the
  private state:
  `witness "wit_AuthPrfPseudonymSK" is defined by both part 0 ("TokenWitnesses") and part 1 ("AuthPrfPseudonymWitnesses")`.
  A bundled module factory that already includes the authenticator's witness
  clashes this way; list the module's own part instead. Each part is called
  once there to read its names.
- Witnesses passed in `options`, by `prepare` or by `create`, are used as they
  are: each returns the whole state.
- `composeWitnesses(...parts)` and `composePrivateState(...parts)` return the
  merged factory, with its `parts`, for `createSimulator` or a `prepare`
  function. Merged witnesses fit the contract's `Witnesses<P>`, so
  `contractFactory: (w) => new Contract<P>(w)` compiles with per-part types.

#### Members that are not circuits

Module-specific helpers live next to the module's witnesses and type `sim` with
`PrivateStateAccess<P>`:

```typescript
// witnesses/OwnableWitnesses.ts
export const OwnableHelpers = (sim: PrivateStateAccess<OwnablePrivateState>) => ({
  privateState: {
    injectSecretKey: (sk: Uint8Array): Promise<OwnablePrivateState> =>
      sim.updatePrivateState(OwnablePrivateState.withSecretKey(sk)),
  },
});
```

`prepare` covers a `create` that takes named arguments, defaults, or state the
witnesses close over:

```typescript
// witnesses/NoteTokenWitnesses.ts
export const prepareNoteToken = ({
  wallet = createNoteWallet(),
  instanceSalt = INSTANCE_SALT,
  ...options
}: NoteTokenOptions = {}) => ({
  args: [instanceSalt] as const,
  options: { ...options, witnesses: options.witnesses ?? NoteTokenWitnesses(wallet) },
  fields: { wallet },
});

// The spec
class NoteTokenSimulator extends defineSimulator(MockNoteToken, {
  privateState: NoteTokenPrivateState.generate,
  prepare: prepareNoteToken,
}) {}

const token = await NoteTokenSimulator.create({ instanceSalt });
token.wallet.pathOverride = path; // read by the witnesses
```

#### Before and after

Before, a hand-written simulator file per mock:

```typescript
import { createSimulator, type SimulatorOptions } from '@openzeppelin/compact-simulator';
import {
  type ContractAddress,
  type Either,
  ledger,
  Contract as MockOwnable,
} from '../../../../artifacts/access/test/mocks/MockOwnable/contract/index.js';
import { OwnablePrivateState, OwnableWitnesses } from '../witnesses/OwnableWitnesses.js';

type OwnableArgs = readonly [initialOwner: Either<Uint8Array, ContractAddress>, isInit: boolean];

const OwnableSimulatorBase = createSimulator<
  OwnablePrivateState,
  ReturnType<typeof ledger>,
  ReturnType<typeof OwnableWitnesses>,
  MockOwnable<OwnablePrivateState>,
  OwnableArgs
>({
  contractFactory: (witnesses) => new MockOwnable<OwnablePrivateState>(witnesses),
  defaultPrivateState: () => OwnablePrivateState.generate(),
  contractArgs: (initialOwner, isInit) => [initialOwner, isInit],
  ledgerExtractor: (state) => ledger(state),
  witnessesFactory: () => OwnableWitnesses(),
  artifactName: 'MockOwnable',
});

export class OwnableSimulator extends OwnableSimulatorBase {
  static async create(
    initialOwner: Either<Uint8Array, ContractAddress>,
    isInit: boolean,
    options: SimulatorOptions<OwnablePrivateState, ReturnType<typeof OwnableWitnesses>> = {},
  ): Promise<OwnableSimulator> {
    return super.create([initialOwner, isInit], options) as Promise<OwnableSimulator>;
  }

  public owner(): Promise<Either<Uint8Array, ContractAddress>> {
    return this.circuits.impure.owner();
  }

  public transferOwnership(newOwner: Either<Uint8Array, ContractAddress>): Promise<[]> {
    return this.circuits.impure.transferOwnership(newOwner);
  }

  public _unsafeTransferOwnership(newOwner: Either<Uint8Array, ContractAddress>): Promise<[]> {
    return this.circuits.impure._unsafeTransferOwnership(newOwner);
  }

  public renounceOwnership(): Promise<[]> {
    return this.circuits.impure.renounceOwnership();
  }

  public assertOnlyOwner(): Promise<[]> {
    return this.circuits.impure.assertOnlyOwner();
  }

  public _transferOwnership(newOwner: Either<Uint8Array, ContractAddress>): Promise<[]> {
    return this.circuits.impure._transferOwnership(newOwner);
  }

  public _unsafeUncheckedTransferOwnership(
    newOwner: Either<Uint8Array, ContractAddress>,
  ): Promise<[]> {
    return this.circuits.impure._unsafeUncheckedTransferOwnership(newOwner);
  }

  public readonly privateState = {
    injectSecretKey: (newSK: Uint8Array): Promise<OwnablePrivateState> =>
      this.updatePrivateState(OwnablePrivateState.withSecretKey(newSK)),
    getCurrentSecretKey: async (): Promise<Uint8Array> => {
      const sk = (await this.getPrivateState()).secretKey;
      if (typeof sk === 'undefined') {
        throw new Error('Missing secret key');
      }
      return Uint8Array.from(sk);
    },
  };
}
```

After, no simulator file. The spec defines the class, and the `privateState` bag
moves next to the witnesses (`OwnableHelpers` above, with `getCurrentSecretKey`
added):

```typescript
class OwnableSimulator extends defineSimulator(MockOwnable, {
  witnesses: OwnableWitnesses,
  privateState: OwnablePrivateState.generate,
  extend: OwnableHelpers,
  artifactName: 'MockOwnable',
}) {}
```

The spec body is unchanged: `OwnableSimulator.create(owner, isInit, { privateState })`,
`ownable.transferOwnership(...)`, `ownable.privateState.injectSecretKey(...)`.

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

`as()` applies to the next call: a circuit method, a `circuits` call, or a
function `extend` adds in place of a circuit method. That call spends it even if
it fails. The call after it runs as the persistent caller, or the default one.
Other `extend` members behave like subclass methods and do not spend the
caller, so in `sim.as('OWNER').transfer(sim.helper())` the `transfer` circuit
runs as `OWNER`. A helper that makes several circuit calls spends the caller on
its first call. To run all of them as one caller, use `setPersistentCaller()`.

> `ownPublicKey()` is a witness value and MUST NOT be used as an authentication
> mechanism. These helpers exist for circuits that take the caller as an input
> to other computations (e.g. commitment derivation).

In live mode, midnight-js encrypts each shielded output sent to a coin public
key with the recipient's encryption public key, and on its own knows only the
calling wallet's. When a circuit sends a coin to another wallet, pass that
wallet's coin and encryption public keys (its `WalletProvider`'s
`getCoinPublicKey()` and `getEncryptionPublicKey()`) through
`scopedTransactionOptions`. Otherwise the call fails to build with
`Unable to resolve encryption public key`:

```typescript
createLiveContext({
  // ...
  scopedTransactionOptions: {
    additionalCoinEncPublicKeyMappings: new Map([
      [bob.getCoinPublicKey(), bob.getEncryptionPublicKey()],
    ]),
  },
});
```

With the option set, each call runs as its own midnight-js scoped transaction.
midnight-js then wraps circuit and submission errors (`Unexpected error
executing scoped transaction ...`), keeping the original message inside.

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
| `<circuit>(...args)` | Call a circuit by name (async; see [Flat Circuit Methods](#4-flat-circuit-methods)) |
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
