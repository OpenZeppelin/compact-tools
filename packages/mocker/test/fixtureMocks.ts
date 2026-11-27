/**
 * The compiled fixture mocks and their simulators. Imported only once globalSetup has built
 * the mocks, so a spec without a compact-mock binary can skip instead of failing to load.
 */

import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { createSimulator } from '@openzeppelin/compact-simulator';
import {
  ledger as claimedLedger,
  Contract as MockClaimed,
} from './fixtures/src/access/test/artifacts/MockClaimed/contract/index.js';
import {
  ledger as claimedFlagLedger,
  Contract as MockClaimedFlag,
} from './fixtures/src/access/test/artifacts/MockClaimedFlag/contract/index.js';
import {
  type ContractAddress,
  type Either,
  Contract as MockOwned,
  ledger as ownedLedger,
} from './fixtures/src/access/test/artifacts/MockOwned/contract/index.js';
import {
  type Caller,
  Contract as MockOwnedCaller,
  ledger as ownedCallerLedger,
} from './fixtures/src/access/test/artifacts/MockOwnedCaller/contract/index.js';
import {
  Contract as MockOwnedKeyed,
  ledger as ownedKeyedLedger,
} from './fixtures/src/access/test/artifacts/MockOwnedKeyed/contract/index.js';
import {
  Contract as MockShielded,
  ledger as shieldedLedger,
} from './fixtures/src/access/test/artifacts/MockShielded/contract/index.js';
import {
  Contract as MockShieldedCaller,
  ledger as shieldedCallerLedger,
} from './fixtures/src/access/test/artifacts/MockShieldedCaller/contract/index.js';
import {
  Contract as MockPseudonym,
  ledger as pseudonymLedger,
} from './fixtures/src/auth/test/artifacts/MockPseudonym/contract/index.js';
import {
  ledger as clickerLedger,
  Contract as MockClicker,
} from './fixtures/src/count/test/artifacts/MockClicker/contract/index.js';
import {
  ledger as hashLedger,
  Contract as MockHash,
} from './fixtures/src/crypto/test/artifacts/MockHash/contract/index.js';
import {
  ledger as bagLedger,
  Contract as MockBag,
} from './fixtures/src/generic/test/artifacts/MockBag/contract/index.js';
import {
  ledger as bagNoInitLedger,
  Contract as MockBagNoInit,
} from './fixtures/src/generic/test/artifacts/MockBagNoInit/contract/index.js';
import {
  ledger as bagPairLedger,
  Contract as MockBagPair,
} from './fixtures/src/generic/test/artifacts/MockBagPair/contract/index.js';
import {
  Contract as MockScale,
  ledger as scaleLedger,
} from './fixtures/src/math/test/artifacts/MockScale/contract/index.js';

export {
  type Caller,
  MockBag,
  MockBagNoInit,
  MockBagPair,
  MockClaimed,
  MockClaimedFlag,
  MockClicker,
  MockHash,
  MockOwned,
  MockOwnedCaller,
  MockOwnedKeyed,
  MockPseudonym,
  MockScale,
  MockShielded,
  MockShieldedCaller,
};

export type Account = Either<Uint8Array, ContractAddress>;
export type SecretState = { secretKey: Uint8Array };
export type ShieldedState = { secretKey: Uint8Array; blinding: Uint8Array };
type NoState = Record<string, never>;

export const pseudonymWitnesses = () => ({
  wit_PseudonymSK({
    privateState,
  }: WitnessContext<unknown, SecretState>): [SecretState, Uint8Array] {
    return [privateState, privateState.secretKey];
  },
});
type PseudonymWitnesses = ReturnType<typeof pseudonymWitnesses>;

export const keyedWitnesses = () => ({
  wit_KeyedSK({
    privateState,
  }: WitnessContext<unknown, SecretState>): [SecretState, Uint8Array] {
    return [privateState, privateState.secretKey];
  },
});
type KeyedWitnesses = ReturnType<typeof keyedWitnesses>;

export const shieldedWitnesses = () => ({
  wit_PseudonymSK({
    privateState,
  }: WitnessContext<unknown, ShieldedState>): [ShieldedState, Uint8Array] {
    return [privateState, privateState.secretKey];
  },
  wit_RandBlinding({
    privateState,
  }: WitnessContext<unknown, ShieldedState>): [ShieldedState, Uint8Array] {
    return [privateState, privateState.blinding];
  },
});
type ShieldedWitnesses = ReturnType<typeof shieldedWitnesses>;

const noWitnesses = (): NoState => ({});

export const OwnedSimulator = createSimulator({
  contractFactory: (witnesses: PseudonymWitnesses) =>
    new MockOwned<SecretState>(witnesses),
  defaultPrivateState: (): SecretState => ({ secretKey: new Uint8Array(32) }),
  contractArgs: (initialOwner: Account, isInit: boolean) => [
    initialOwner,
    isInit,
  ],
  ledgerExtractor: (state) => ownedLedger(state),
  witnessesFactory: () => pseudonymWitnesses(),
  flatCircuits: true,
});

export const OwnedKeyedSimulator = createSimulator({
  contractFactory: (witnesses: KeyedWitnesses) =>
    new MockOwnedKeyed<SecretState>(witnesses),
  defaultPrivateState: (): SecretState => ({ secretKey: new Uint8Array(32) }),
  contractArgs: (initialOwner: Account) => [initialOwner],
  ledgerExtractor: (state) => ownedKeyedLedger(state),
  witnessesFactory: () => keyedWitnesses(),
  flatCircuits: true,
});

export const OwnedCallerSimulator = createSimulator({
  contractFactory: (witnesses: NoState) =>
    new MockOwnedCaller<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: (initialOwner: Account) => [initialOwner],
  ledgerExtractor: (state) => ownedCallerLedger(state),
  witnessesFactory: noWitnesses,
  flatCircuits: true,
});

export const ClaimedSimulator = createSimulator({
  contractFactory: (witnesses: PseudonymWitnesses) =>
    new MockClaimed<SecretState>(witnesses),
  defaultPrivateState: (): SecretState => ({ secretKey: new Uint8Array(32) }),
  contractArgs: () => [],
  ledgerExtractor: (state) => claimedLedger(state),
  witnessesFactory: () => pseudonymWitnesses(),
  flatCircuits: true,
});

export const ClaimedFlagSimulator = createSimulator({
  contractFactory: (witnesses: PseudonymWitnesses) =>
    new MockClaimedFlag<SecretState>(witnesses),
  defaultPrivateState: (): SecretState => ({ secretKey: new Uint8Array(32) }),
  contractArgs: (isInit: boolean) => [isInit],
  ledgerExtractor: (state) => claimedFlagLedger(state),
  witnessesFactory: () => pseudonymWitnesses(),
  flatCircuits: true,
});

export const ShieldedSimulator = createSimulator({
  contractFactory: (witnesses: ShieldedWitnesses) =>
    new MockShielded<ShieldedState>(witnesses),
  defaultPrivateState: (): ShieldedState => ({
    secretKey: new Uint8Array(32),
    blinding: new Uint8Array(32),
  }),
  contractArgs: (salt: Uint8Array) => [salt],
  ledgerExtractor: (state) => shieldedLedger(state),
  witnessesFactory: () => shieldedWitnesses(),
  flatCircuits: true,
});

export const ShieldedCallerSimulator = createSimulator({
  contractFactory: (witnesses: NoState) =>
    new MockShieldedCaller<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: (salt: Uint8Array) => [salt],
  ledgerExtractor: (state) => shieldedCallerLedger(state),
  witnessesFactory: noWitnesses,
  flatCircuits: true,
});

export const PseudonymSimulator = createSimulator({
  contractFactory: (witnesses: PseudonymWitnesses) =>
    new MockPseudonym<SecretState>(witnesses),
  defaultPrivateState: (): SecretState => ({ secretKey: new Uint8Array(32) }),
  contractArgs: () => [],
  ledgerExtractor: (state) => pseudonymLedger(state),
  witnessesFactory: () => pseudonymWitnesses(),
  flatCircuits: true,
});

export const ClickerSimulator = createSimulator({
  contractFactory: (witnesses: NoState) => new MockClicker<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: () => [],
  ledgerExtractor: (state) => clickerLedger(state),
  witnessesFactory: noWitnesses,
  flatCircuits: true,
});

export const HashSimulator = createSimulator({
  contractFactory: (witnesses: NoState) => new MockHash<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: (seed: bigint) => [seed],
  ledgerExtractor: (state) => hashLedger(state),
  witnessesFactory: noWitnesses,
  flatCircuits: true,
});

export const BagSimulator = createSimulator({
  contractFactory: (witnesses: NoState) => new MockBag<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: (seed: bigint[]) => [seed],
  ledgerExtractor: (state) => bagLedger(state),
  witnessesFactory: noWitnesses,
  flatCircuits: true,
});

export const BagNoInitSimulator = createSimulator({
  contractFactory: (witnesses: NoState) =>
    new MockBagNoInit<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: () => [],
  ledgerExtractor: (state) => bagNoInitLedger(state),
  witnessesFactory: noWitnesses,
  flatCircuits: true,
});

export const BagPairSimulator = createSimulator({
  contractFactory: (witnesses: NoState) => new MockBagPair<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: (seed: bigint[]) => [seed],
  ledgerExtractor: (state) => bagPairLedger(state),
  witnessesFactory: noWitnesses,
  flatCircuits: true,
});

export const ScaleSimulator = createSimulator({
  contractFactory: (witnesses: NoState) => new MockScale<NoState>(witnesses),
  defaultPrivateState: (): NoState => ({}),
  contractArgs: () => [],
  ledgerExtractor: (state) => scaleLedger(state),
  witnessesFactory: noWitnesses,
  flatCircuits: true,
});
