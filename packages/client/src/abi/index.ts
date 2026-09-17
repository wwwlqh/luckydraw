// The four ABIs the client needs, as `as const` arrays written by scripts/generate.ts.
// LuckyVault and LuckyDraw are the only contracts this library signs against; Multicall3 batches reads into
// one block (SPEC §10.1) and AggregatorV3Interface reads a price feed directly when a quote must be checked.

export {aggregatorV3Abi} from "./generated/aggregatorV3.ts";
export {luckyDrawAbi} from "./generated/luckyDraw.ts";
export {luckyVaultAbi} from "./generated/luckyVault.ts";
export {multicall3Abi} from "./generated/multicall3.ts";
// Decoded ethers values become the generated types here, driven by the ABI's own `internalType`.
export {
  type AbiEntryLike,
  type AbiParamLike,
  indexEventInputs,
  indexFunctionOutputs,
  normalizeAbiStruct,
  normalizeAbiValue,
  toBigInt,
} from "./normalize.ts";
