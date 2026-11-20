import {
  type CallProofData,
  decodeZswapLocalState,
} from '@midnight-ntwrk/compact-runtime';
import {
  ChargedState,
  type CoinPublicKey,
  ContractCallPrototype,
  type ContractOperation,
  coinCommitment,
  type EncPublicKey,
  Intent,
  type LedgerParameters,
  type PartitionedTranscript,
  PreTranscript,
  partitionTranscripts,
  QueryContext,
  StateValue,
  type SyntheticCost,
  Transaction,
  type UnprovenOffer,
  type UnprovenOutput,
  type UnprovenTransaction,
  UnshieldedOffer,
  ZswapOffer,
  ZswapOutput,
  ZswapTransient,
} from '@midnightntwrk/ledger-v9';

/** Everything a single-call transaction needs beyond the call itself. */
export interface BuildSettings {
  params: LedgerParameters;
  networkId: string;
  ttl: Date;
  contractAddress: string;
  /** Fixed communication commitment randomness; the SDK samples it per root call. */
  communicationRandomness: string;
  encryptionKey: (coinPublicKey: CoinPublicKey) => EncPublicKey;
}

/** One executed circuit call and the deployed operation it targets. */
export interface ExecutedCall {
  proofData: CallProofData;
  operation: ContractOperation;
}

const GUARANTEED = 0;

/** Ledger query context the call started from, as compact-js builds it for partitioning. */
function preTranscript(proofData: CallProofData): PreTranscript {
  const initial = proofData.initialQueryContext;
  const state = StateValue.decode(initial.state.state.encode());
  let context = new QueryContext(new ChargedState(state), initial.address);
  context.block = initial.block;
  context.effects = initial.effects;
  for (const [commitment, index] of proofData.finalQueryContext.comIndices) {
    context = context.insertCommitment(commitment, index);
  }
  return new PreTranscript(
    context,
    proofData.publicTranscript,
    proofData.commCommData?.commComm,
  );
}

function mergeOffers(
  offers: (UnprovenOffer | undefined)[],
): UnprovenOffer | undefined {
  return offers.reduce<UnprovenOffer | undefined>(
    (merged, offer) =>
      merged === undefined ? offer : offer ? merged.merge(offer) : merged,
    undefined,
  );
}

/**
 * Zswap offers for the coins one call created or spent, routed as midnight-js does: a coin
 * claimed by the guaranteed transcript goes to segment 0, one claimed by the fallible
 * transcript to the call's own segment.
 */
function zswapOffers(
  proofData: CallProofData,
  [guaranteed, fallible]: PartitionedTranscript,
  segment: number,
  settings: BuildSettings,
): { guaranteed?: UnprovenOffer; fallible?: UnprovenOffer } {
  const local = decodeZswapLocalState(proofData.zswapLocalState);
  const routeCommitment = (commitment: string): number => {
    const claims = (transcript: typeof guaranteed) =>
      transcript !== undefined &&
      (transcript.effects.claimedShieldedReceives.includes(commitment) ||
        transcript.effects.claimedShieldedSpends.includes(commitment));
    if (claims(guaranteed)) return GUARANTEED;
    if (claims(fallible)) return segment;
    return GUARANTEED;
  };

  const outputs = new Map<
    string,
    { segment: number; output: UnprovenOutput }
  >();
  for (const { coinInfo, recipient } of local.outputs) {
    let routed: { segment: number; output: UnprovenOutput };
    if (recipient.is_left) {
      const target = routeCommitment(coinCommitment(coinInfo, recipient.left));
      routed = {
        segment: target,
        output: ZswapOutput.new(
          coinInfo,
          target,
          recipient.left,
          settings.encryptionKey(recipient.left),
        ),
      };
    } else {
      // The commitment does not depend on the segment, so a segment-0 output finds it.
      const probe = ZswapOutput.newContractOwned(
        coinInfo,
        GUARANTEED,
        recipient.right,
      );
      const target = routeCommitment(probe.commitment);
      routed = {
        segment: target,
        output:
          target === GUARANTEED
            ? probe
            : ZswapOutput.newContractOwned(coinInfo, target, recipient.right),
      };
    }
    outputs.set(coinKey(coinInfo), routed);
  }

  const bySegment = new Map<number, UnprovenOffer[]>();
  const add = (target: number, offer: UnprovenOffer) =>
    bySegment.set(target, [...(bySegment.get(target) ?? []), offer]);

  for (const input of local.inputs) {
    const key = coinKey(input);
    const created = outputs.get(key);
    if (created === undefined) {
      throw new Error(
        `circuit ${proofData.circuitId} spends a shielded coin it did not create; the profiler can only spend coins created in the same call`,
      );
    }
    outputs.delete(key);
    add(
      created.segment,
      ZswapOffer.fromTransient(
        ZswapTransient.newFromContractOwnedOutput(
          input,
          created.segment,
          created.output,
        ),
      ),
    );
  }
  for (const { segment: target, output } of outputs.values()) {
    add(target, ZswapOffer.fromOutput(output));
  }

  return {
    guaranteed: mergeOffers(bySegment.get(GUARANTEED) ?? []),
    fallible: mergeOffers(bySegment.get(segment) ?? []),
  };
}

function coinKey(coin: { type: string; nonce: string; value: bigint }) {
  return `${coin.type}:${coin.nonce}:${coin.value}`;
}

/** Unshielded outputs the transcript pays to a user, which midnight-js adds as an offer. */
function userOutputs(transcript: PartitionedTranscript[number]) {
  if (transcript === undefined) return [];
  return [...transcript.effects.claimedUnshieldedSpends].flatMap(
    ([[tokenType, address], value]) =>
      address.tag === 'user' && tokenType.tag !== 'dust'
        ? [{ value, owner: address.address, type: tokenType.raw }]
        : [],
  );
}

/**
 * An unproven transaction holding one call, its intent at `segment`.
 *
 * Segment 1 is the shape `Transaction.fromParts` builds; any other segment is added explicitly.
 */
export function singleCallTransaction(
  { proofData, operation }: ExecutedCall,
  segment: number,
  settings: BuildSettings,
): UnprovenTransaction {
  const [transcripts] = partitionTranscripts(
    [preTranscript(proofData)],
    settings.params,
  );
  const [guaranteed, fallible] = transcripts;
  const intent = Intent.new(settings.ttl).addCall(
    new ContractCallPrototype(
      settings.contractAddress,
      proofData.circuitId,
      operation,
      guaranteed,
      fallible,
      proofData.privateTranscriptOutputs,
      proofData.input,
      proofData.output,
      settings.communicationRandomness,
      proofData.circuitId,
    ),
  );
  const guaranteedPayouts = userOutputs(guaranteed);
  if (guaranteedPayouts.length > 0) {
    intent.guaranteedUnshieldedOffer = UnshieldedOffer.new(
      [],
      guaranteedPayouts,
      [],
    );
  }
  const falliblePayouts = userOutputs(fallible);
  if (falliblePayouts.length > 0) {
    intent.fallibleUnshieldedOffer = UnshieldedOffer.new(
      [],
      falliblePayouts,
      [],
    );
  }

  const offers = zswapOffers(proofData, transcripts, segment, settings);
  if (segment === 1) {
    return Transaction.fromParts(
      settings.networkId,
      offers.guaranteed,
      offers.fallible,
      intent,
    );
  }
  let tx = Transaction.fromParts(settings.networkId, offers.guaranteed);
  tx = tx.addIntent({ tag: 'specific', value: segment }, intent);
  if (offers.fallible !== undefined) {
    tx = tx.addZswapOffer({ tag: 'specific', value: segment }, offers.fallible);
  }
  return tx;
}

/** One transaction for a scenario: call `i` gets its own intent at segment `i + 1`. */
export function scenarioTransaction(
  calls: ExecutedCall[],
  settings: BuildSettings,
): UnprovenTransaction {
  if (calls.length === 0) {
    throw new Error('a scenario must make at least one call');
  }
  return calls
    .map((call, index) => singleCallTransaction(call, index + 1, settings))
    .reduce((merged, part) => merged.merge(part));
}

/** The position just past the second colon, where the node reads the tag's end. */
function tagEnd(bytes: Uint8Array): number {
  let colons = 0;
  for (let index = 0; index < Math.min(bytes.length, 512); index++) {
    if (bytes[index] === 0x3a && ++colons === 2) return index + 1;
  }
  throw new Error('no tag header ends within the first 512 bytes');
}

/** The SCALE compact `u32` node count right after the tag header. */
export function declaredNodes(bytes: Uint8Array): number {
  const body = bytes.subarray(tagEnd(bytes));
  const mode = (body[0] ?? 0) & 0b11;
  const width = mode === 0 ? 1 : mode === 1 ? 2 : mode === 2 ? 4 : 5;
  if (body.length < width) throw new Error('truncated node count');
  const view = new DataView(body.buffer, body.byteOffset, width);
  switch (width) {
    case 1:
      return view.getUint8(0) >> 2;
    case 2:
      return view.getUint16(0, true) >>> 2;
    case 4:
      return view.getUint32(0, true) >>> 2;
    default:
      // Big-integer mode: the value follows the mode byte.
      return view.getUint32(1, true);
  }
}

/** Cost fields as the manifest stores them: decimal strings. */
export interface CostStrings {
  readTime: string;
  computeTime: string;
  blockUsage: string;
  bytesWritten: string;
  bytesChurned: string;
}

export interface Measurement {
  cost: CostStrings;
  serializedLen: number;
  declaredNodes: number;
}

export function measure(
  tx: UnprovenTransaction,
  params: LedgerParameters,
): { bytes: Uint8Array; measurement: Measurement } {
  const bytes = tx.serialize();
  const cost: SyntheticCost = tx.cost(params, false);
  return {
    bytes,
    measurement: {
      cost: {
        readTime: cost.readTime.toString(),
        computeTime: cost.computeTime.toString(),
        blockUsage: cost.blockUsage.toString(),
        bytesWritten: cost.bytesWritten.toString(),
        bytesChurned: cost.bytesChurned.toString(),
      },
      serializedLen: bytes.length,
      declaredNodes: declaredNodes(bytes),
    },
  };
}
