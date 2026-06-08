// Constructor args for TokenExample, read by `compact-deploy` via the
// `args = { module = "./deploy/TokenExample.args.mjs" }` ref in
// compact.toml.
//
// Order matches the contract's constructor:
//   (_name, _symbol, _decimals, _treasury, _maxSupply,
//    _feeBps, _quorum, _isMintable, _tag)
//
// All Compact Uint<N> map to JS BigInt regardless of width (the
// compiler-emitted `.d.ts` types them as `bigint`).

export function args() {
  return [
    'OpenZeppelin Example Token', // _name:       string         (Opaque<"string">)
    'OZE', // _symbol:     string         (Opaque<"string">)
    18n, // _decimals:   bigint         (Uint<8>)
    new Uint8Array(32).fill(0xab), // _treasury:   Uint8Array(32) (Bytes<32>)
    1_000_000_000_000_000_000_000_000n, // _maxSupply:  bigint         (Uint<128>)
    250n, // _feeBps:     bigint         (Uint<32>)
    7n, // _quorum:     bigint         (Uint<64>)
    true, // _isMintable: boolean        (Boolean)
    new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe]), // _tag: Uint8Array(8) (Bytes<8>)
  ];
}
