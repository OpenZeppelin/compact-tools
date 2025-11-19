import {
  type DomainSeperator,
  decodeCoinPublicKey,
} from '@midnight-ntwrk/compact-runtime';
import { encodeContractAddress } from '@midnight-ntwrk/ledger';
import { encodeTokenType, tokenType } from '@midnight-ntwrk/onchain-runtime';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ContractAddress,
  Either,
  ZswapCoinPublicKey,
} from '../fixtures/test-artifacts/UTXO/contract/index.cjs';
import * as utils from '../fixtures/utils/address.js';
import { UTXOSimulator } from './UTXOSimulator';

const DOMAIN_1 = new Uint8Array(32).fill(1);
const DOMAIN_2 = new Uint8Array(32).fill(2);
const DOMAIN_3 = new Uint8Array(32).fill(3);
const DOMAINS = [DOMAIN_1, DOMAIN_2, DOMAIN_3];

const NONCE_1 = new Uint8Array(32).fill(4);
const NONCE_2 = new Uint8Array(32).fill(5);
const NONCE_3 = new Uint8Array(32).fill(6);
const NONCES = [NONCE_1, NONCE_2, NONCE_3];

const AMOUNT_1 = 1700n;
const AMOUNT_2 = 1800000000n;
const AMOUNT_3 = 1900000000000000n;
const AMOUNTS = [AMOUNT_1, AMOUNT_2, AMOUNT_3];

const [ALICE, zALICE] = utils.generateEitherPubKeyPair('ALICE');
const [BOB, zBOB] = utils.generateEitherPubKeyPair('BOB');
const [CAROL, zCAROL] = utils.generateEitherPubKeyPair('CAROL');
const RECIPIENTS = [zALICE, zBOB, zCAROL];

//
// Helpers
//

const calculateColor = (domain: DomainSeperator, addr: string): Uint8Array => {
  return encodeTokenType(tokenType(domain, addr));
};

const encodeInstanceAddress = (addr: string) => {
  return {
    is_left: false,
    left: { bytes: utils.zeroUint8Array() },
    right: { bytes: encodeContractAddress(addr) },
  };
};

const createExpOutput = (
  nonce: Uint8Array,
  color: Uint8Array,
  value: bigint,
  recipient: Either<ZswapCoinPublicKey, ContractAddress>,
) => {
  return {
    coinInfo: {
      nonce: nonce,
      color: color,
      value: value,
    },
    recipient: recipient,
  };
};

let contract: UTXOSimulator;

describe('UTXO test', () => {
  beforeEach(() => {
    contract = new UTXOSimulator();
  });

  describe('coinPublicKey', () => {
    // Helper to make the test callers output readable
    const describeCoinPK = (pk: string): string => {
      return `${pk.slice(0, 8)}...${pk.slice(-8)}`;
    };

    const testCallers = [
      {
        caller: ALICE,
        encodedAddy: zALICE,
        readableAddy: describeCoinPK(decodeCoinPublicKey(zALICE.left.bytes)),
      },
      {
        caller: BOB,
        encodedAddy: zBOB,
        readableAddy: describeCoinPK(decodeCoinPublicKey(zBOB.left.bytes)),
      },
      {
        caller: CAROL,
        encodedAddy: zCAROL,
        readableAddy: describeCoinPK(decodeCoinPublicKey(zCAROL.left.bytes)),
      },
    ];
    it.each(testCallers)(
      'should return $readableAddy when called from the corresponding coinPublicKey $caller',
      ({ caller, encodedAddy }) => {
        contract.as(caller).mint(DOMAIN_1, AMOUNT_1, NONCE_1, zALICE);
        expect(contract.getZswapState().coinPublicKey).toEqual(
          encodedAddy.left,
        );
      },
    );

    it('should return zero when there is no caller', () => {
      contract.mint(DOMAIN_1, AMOUNT_1, NONCE_1, zALICE);
      expect(contract.getZswapState().coinPublicKey).toEqual(
        utils.ZERO_KEY.left,
      );
    });
  });

  describe('currentIndex', () => {
    it('should start with a current index of zero', () => {
      expect(contract.getZswapState().currentIndex).toEqual(0n);
    });

    it('should track the current index with created outputs', () => {
      contract.mint(DOMAIN_1, AMOUNT_1, NONCE_1, zALICE);
      expect(contract.getZswapState().currentIndex).toEqual(1n);

      contract.mint(DOMAIN_1, AMOUNT_1, NONCE_1, zALICE);
      expect(contract.getZswapState().currentIndex).toEqual(2n);

      for (let i = 0; i < 8; i++) {
        contract.mint(DOMAIN_1, AMOUNT_1, NONCE_1, zALICE);
      }
      expect(contract.getZswapState().currentIndex).toEqual(10n);
    });

    // Receiving a coin resets the index
    it.skip('should track the current index when creating inputs and outputs', () => {
      // Bump index to 10
      for (let i = 0; i < NONCES.length; i++) {
        contract.mint(DOMAIN_1, AMOUNT_1, NONCES[i], zALICE);
      }
      expect(contract.getZswapState().currentIndex).toEqual(3n);

      const thisColor = calculateColor(DOMAIN_1, contract.contractAddress);
      const thisCoin = {
        nonce: NONCE_1,
        color: thisColor,
        value: AMOUNT_1,
      };
      contract.as(ALICE).receiveToken(thisCoin);

      expect(contract.getZswapState().currentIndex).toEqual(1n);
    });
  });

  describe('Outputs', () => {
    it('should match zswap outputs with single output', () => {
      contract.mint(DOMAIN_1, AMOUNT_1, NONCE_1, zALICE);
      const zswapRes = contract.getZswapState();

      // Check inputs are empty
      const inputs = zswapRes.inputs;
      expect(inputs).toEqual([]);

      // Check outputs
      const out = zswapRes.outputs;
      const expected = {
        coinInfo: {
          nonce: NONCE_1,
          color: calculateColor(DOMAIN_1, contract.contractAddress),
          value: AMOUNT_1,
        },
        recipient: zALICE,
      };

      // Check values
      expect(out[0]).toEqual(expected);

      // Check output len
      expect(out.length).toEqual(1);
    });

    it('should match zswap outputs with multiple outputs', () => {
      for (let i = 0; i < RECIPIENTS.length; i++) {
        contract.mint(DOMAINS[i], AMOUNTS[i], NONCES[i], RECIPIENTS[i]);
      }

      const zswapRes = contract.getZswapState();

      // Check inputs are empty
      const inputs = zswapRes.inputs;
      expect(inputs).toEqual([]);

      // Bind outputs
      const out = zswapRes.outputs;

      // Check output len
      expect(out.length).toEqual(3);

      // Check output values
      for (let i = 0; i < RECIPIENTS.length; i++) {
        const expected = {
          coinInfo: {
            nonce: NONCES[i],
            color: calculateColor(DOMAINS[i], contract.contractAddress),
            value: AMOUNTS[i],
          },
          recipient: RECIPIENTS[i],
        };
        expect(expected).toEqual(out[i]);
      }
    });
  });

  describe('Inputs and outputs', () => {
    it('should match input and outputs', () => {
      const sendAmt = 1n;
      const encodedContractAddy = encodeInstanceAddress(
        contract.contractAddress,
      );
      const thisColor = calculateColor(DOMAIN_1, contract.contractAddress);

      // Mint + receive = 2 outputs
      contract.mint(DOMAIN_1, AMOUNT_1, NONCE_1, zALICE);
      const thisCoin = {
        nonce: NONCE_1,
        color: thisColor,
        value: AMOUNT_1,
      };
      contract.as(ALICE).receiveToken(thisCoin);

      // Create input and output (1 input + 3 outputs)
      const coinInput = contract.getPublicState()._coin;
      contract.sendToken(coinInput, zBOB, sendAmt);

      const zswapRes = contract.getZswapState();

      // Check input len
      const inputs = zswapRes.inputs;
      expect(inputs.length).toEqual(1);

      // Check input data
      const expInput = {
        color: thisColor,
        mt_index: 0n,
        nonce: NONCE_1,
        value: AMOUNT_1,
      };
      expect(inputs[0]).toEqual(expInput);

      // Check output len
      const outputs = zswapRes.outputs;
      expect(outputs.length).toEqual(3);

      // Check output data
      const expOutput_1 = createExpOutput(
        NONCE_1,
        thisColor,
        AMOUNT_1,
        encodedContractAddy,
      );
      expect(outputs[0]).toEqual(expOutput_1);

      // Check output 2 data
      const expOutput_2 = createExpOutput(NONCE_1, thisColor, sendAmt, zBOB);
      // We skip nonce here bc it's random
      expect(outputs[1].coinInfo.color).toEqual(expOutput_2.coinInfo.color);
      expect(outputs[1].coinInfo.value).toEqual(expOutput_2.coinInfo.value);
      expect(outputs[1].recipient).toEqual(expOutput_2.recipient);

      // Check output 3 data
      const expOutput_3 = createExpOutput(
        NONCE_1,
        thisColor,
        AMOUNT_1 - sendAmt,
        encodedContractAddy,
      );
      // We skip nonce here bc it's random
      expect(outputs[2].coinInfo.color).toEqual(expOutput_3.coinInfo.color);
      expect(outputs[2].coinInfo.value).toEqual(expOutput_3.coinInfo.value);
      expect(outputs[2].recipient).toEqual(expOutput_3.recipient);
    });
  });
});
