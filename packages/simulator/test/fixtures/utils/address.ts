import {
  encodeCoinPublicKey,
  encodeContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import type * as Compact from '../artifacts/SampleZOwnable/contract/index.js';

const PREFIX_ADDRESS = '0200';

/**
 * @description Converts an ASCII string to its hexadecimal representation,
 * left-padded with zeros to a specified length. Useful for generating
 * fixed-size hex strings for encoding.
 * @param str ASCII string to convert.
 * @param len Total desired length of the resulting hex string. Defaults to 64.
 * @returns Hexadecimal string representation of `str`, padded to `length` characters.
 */
export const toHexPadded = (str: string, len = 64) =>
  Buffer.from(str, 'ascii').toString('hex').padStart(len, '0');

/**
 * @description Generates ZswapCoinPublicKey from `str` for testing purposes.
 * @param str String to hexify and encode.
 * @returns Encoded `ZswapCoinPublicKey`.
 */
export const encodeToPK = (str: string): Compact.ZswapCoinPublicKey => ({
  bytes: encodeCoinPublicKey(toHexPadded(str)),
});

/**
 * @description Generates ContractAddress from `str` for testing purposes.
 *              Truncates to 30 bytes before prepending PREFIX_ADDRESS to comply
 *              with field value constraints (max unsigned integer is 2^248-1).
 *              The truncation compensates for the bytes added by the prefix.
 * @param str String to hexify and encode.
 * @returns Encoded `Compact.ContractAddress`.
 */
export const encodeToAddress = (str: string): Compact.ContractAddress => {
  const hex = toHexPadded(str);
  const truncated = hex.slice(0, -4);
  return {
    bytes: encodeContractAddress(PREFIX_ADDRESS + truncated),
  };
};

/**
 * @description Generates an Either object for ZswapCoinPublicKey for testing.
 *              For use when an Either argument is expected.
 * @param str String to hexify and encode.
 * @returns Defined Either object for ZswapCoinPublicKey.
 */
export const createEitherTestUser = (str: string) => ({
  is_left: true,
  left: encodeToPK(str),
  right: encodeToAddress(''),
});

/**
 * @description Generates an Either object for ContractAddress for testing.
 *              For use when an Either argument is expected.
 * @param str String to hexify and encode.
 * @returns Defined Either object for ContractAddress.
 */
export const createEitherTestContractAddress = (str: string) => ({
  is_left: false,
  left: encodeToPK(''),
  right: encodeToAddress(str),
});

const baseGeneratePubKeyPair = (
  str: string,
  asEither: boolean,
): [
  string,
  (
    | Compact.ZswapCoinPublicKey
    | Compact.Either<Compact.ZswapCoinPublicKey, Compact.ContractAddress>
  ),
] => {
  const pk = toHexPadded(str);
  const zpk = asEither ? createEitherTestUser(str) : encodeToPK(str);
  return [pk, zpk];
};

export const generatePubKeyPair = (str: string) =>
  baseGeneratePubKeyPair(str, false) as [string, Compact.ZswapCoinPublicKey];

export const generateEitherPubKeyPair = (str: string) =>
  baseGeneratePubKeyPair(str, true) as [
    string,
    Compact.Either<Compact.ZswapCoinPublicKey, Compact.ContractAddress>,
  ];

/**
 * @description Serializes a field value to a fixed-length little-endian byte
 *              array, matching the contract's Uint→Bytes encoding. Throws
 *              rather than truncating, as compact-runtime 0.16's
 *              `convertFieldToBytes` did.
 * @param value Field value to serialize.
 * @param length Byte length. Defaults to 32.
 * @returns The encoded bytes.
 */
export const convertFieldToBytes = (value: bigint, length = 32): Uint8Array => {
  const out = new Uint8Array(length);
  let rest = value;
  for (let i = 0; i < length; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) {
    throw new RangeError(`${value} does not fit into ${length} bytes`);
  }
  return out;
};

/** @description A zero-filled byte array of `length`. */
export const zeroUint8Array = (length = 32) => convertFieldToBytes(0n, length);

export const ZERO_KEY = {
  is_left: true,
  left: { bytes: zeroUint8Array() },
  right: encodeToAddress(''),
};

export const ZERO_ADDRESS = {
  is_left: false,
  left: encodeToPK(''),
  right: { bytes: zeroUint8Array() },
};
