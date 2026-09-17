// GENERATED FILE - DO NOT EDIT BY HAND.
// Source: contracts/src/Types.sol, contracts/src/Errors.sol and the generated ABIs
// Written by packages/client/scripts/generate.ts. Regenerate with `node scripts/generate.ts` after
// `forge build`; `node scripts/generate.ts --check` fails when this file is stale.

import type {Address, Hex} from "./common.ts";

// ---------------------------------------------------------------------------
// Enums (contracts/src/Types.sol). Member order is ABI order and is never sorted.
// ---------------------------------------------------------------------------

export const Kind = {
  Day100: 0,
  Day1k: 1,
  Day10k: 2,
  Week1k: 3,
  Week10k: 4,
  Week100k: 5,
  Month100k: 6,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];
export const KindNames = ["Day100", "Day1k", "Day10k", "Week1k", "Week10k", "Week100k", "Month100k"] as const;
export type KindName = (typeof KindNames)[number];
export function kindName(value: Kind): KindName {
  const name = KindNames[value];
  if (name === undefined) throw new RangeError(`Kind value out of range: ${value}`);
  return name;
}

export const Cadence = {
  Day: 0,
  Week: 1,
  Month: 2,
} as const;
export type Cadence = (typeof Cadence)[keyof typeof Cadence];
export const CadenceNames = ["Day", "Week", "Month"] as const;
export type CadenceName = (typeof CadenceNames)[number];
export function cadenceName(value: Cadence): CadenceName {
  const name = CadenceNames[value];
  if (name === undefined) throw new RangeError(`Cadence value out of range: ${value}`);
  return name;
}

export const State = {
  Open: 0,
  AwaitingRequest: 1,
  Drawing: 2,
  Ready: 3,
  Settled: 4,
  Refunding: 5,
  Void: 6,
} as const;
export type State = (typeof State)[keyof typeof State];
export const StateNames = [
  "Open",
  "AwaitingRequest",
  "Drawing",
  "Ready",
  "Settled",
  "Refunding",
  "Void",
] as const;
export type StateName = (typeof StateNames)[number];
export function stateName(value: State): StateName {
  const name = StateNames[value];
  if (name === undefined) throw new RangeError(`State value out of range: ${value}`);
  return name;
}

export const ReleaseReason = {
  Prize: 0,
  Fee: 1,
  Refund: 2,
} as const;
export type ReleaseReason = (typeof ReleaseReason)[keyof typeof ReleaseReason];
export const ReleaseReasonNames = ["Prize", "Fee", "Refund"] as const;
export type ReleaseReasonName = (typeof ReleaseReasonNames)[number];
export function releaseReasonName(value: ReleaseReason): ReleaseReasonName {
  const name = ReleaseReasonNames[value];
  if (name === undefined) throw new RangeError(`ReleaseReason value out of range: ${value}`);
  return name;
}

export const RefundReason = {
  InsufficientPlayers: 0,
  RequestDeadlineExpired: 1,
} as const;
export type RefundReason = (typeof RefundReason)[keyof typeof RefundReason];
export const RefundReasonNames = ["InsufficientPlayers", "RequestDeadlineExpired"] as const;
export type RefundReasonName = (typeof RefundReasonNames)[number];
export function refundReasonName(value: RefundReason): RefundReasonName {
  const name = RefundReasonNames[value];
  if (name === undefined) throw new RangeError(`RefundReason value out of range: ${value}`);
  return name;
}

export const ReferenceKind = {
  ExactToken: 0,
  UnderlyingAsset: 1,
} as const;
export type ReferenceKind = (typeof ReferenceKind)[keyof typeof ReferenceKind];
export const ReferenceKindNames = ["ExactToken", "UnderlyingAsset"] as const;
export type ReferenceKindName = (typeof ReferenceKindNames)[number];
export function referenceKindName(value: ReferenceKind): ReferenceKindName {
  const name = ReferenceKindNames[value];
  if (name === undefined) throw new RangeError(`ReferenceKind value out of range: ${value}`);
  return name;
}

export const CallbackIgnoreReason = {
  UnknownRequest: 0,
  DuplicateOrWrongState: 1,
  Malformed: 2,
} as const;
export type CallbackIgnoreReason = (typeof CallbackIgnoreReason)[keyof typeof CallbackIgnoreReason];
export const CallbackIgnoreReasonNames = ["UnknownRequest", "DuplicateOrWrongState", "Malformed"] as const;
export type CallbackIgnoreReasonName = (typeof CallbackIgnoreReasonNames)[number];
export function callbackIgnoreReasonName(value: CallbackIgnoreReason): CallbackIgnoreReasonName {
  const name = CallbackIgnoreReasonNames[value];
  if (name === undefined) throw new RangeError(`CallbackIgnoreReason value out of range: ${value}`);
  return name;
}

export const QuoteReason = {
  None: 0,
  InvalidRound: 1,
  EntryWindowClosed: 2,
  InvalidAmount: 3,
  BuysPaused: 4,
  PriceUnavailable: 5,
  PriceInvalid: 6,
  PriceStale: 7,
  PriceDecimalsChanged: 8,
  BelowMinimum: 9,
  InsufficientBalance: 10,
  SeedAccountCannotBuy: 11,
  ArithmeticOverflow: 12,
} as const;
export type QuoteReason = (typeof QuoteReason)[keyof typeof QuoteReason];
export const QuoteReasonNames = [
  "None",
  "InvalidRound",
  "EntryWindowClosed",
  "InvalidAmount",
  "BuysPaused",
  "PriceUnavailable",
  "PriceInvalid",
  "PriceStale",
  "PriceDecimalsChanged",
  "BelowMinimum",
  "InsufficientBalance",
  "SeedAccountCannotBuy",
  "ArithmeticOverflow",
] as const;
export type QuoteReasonName = (typeof QuoteReasonNames)[number];
export function quoteReasonName(value: QuoteReason): QuoteReasonName {
  const name = QuoteReasonNames[value];
  if (name === undefined) throw new RangeError(`QuoteReason value out of range: ${value}`);
  return name;
}

export const SeedSkipReason = {
  NotConfigured: 0,
  NotAuthorized: 1,
  InsufficientSeedBalance: 2,
  NotOpen: 3,
} as const;
export type SeedSkipReason = (typeof SeedSkipReason)[keyof typeof SeedSkipReason];
export const SeedSkipReasonNames = [
  "NotConfigured",
  "NotAuthorized",
  "InsufficientSeedBalance",
  "NotOpen",
] as const;
export type SeedSkipReasonName = (typeof SeedSkipReasonNames)[number];
export function seedSkipReasonName(value: SeedSkipReason): SeedSkipReasonName {
  const name = SeedSkipReasonNames[value];
  if (name === undefined) throw new RangeError(`SeedSkipReason value out of range: ${value}`);
  return name;
}

export const CloseReason = {
  Cutoff: 0,
  TargetReached: 1,
} as const;
export type CloseReason = (typeof CloseReason)[keyof typeof CloseReason];
export const CloseReasonNames = ["Cutoff", "TargetReached"] as const;
export type CloseReasonName = (typeof CloseReasonNames)[number];
export function closeReasonName(value: CloseReason): CloseReasonName {
  const name = CloseReasonNames[value];
  if (name === undefined) throw new RangeError(`CloseReason value out of range: ${value}`);
  return name;
}

// ---------------------------------------------------------------------------
// Structs reachable from the generated ABIs. Every integer is a bigint (SPEC §5.1, §8.1).
// ---------------------------------------------------------------------------

/** Solidity `ILuckyVault.AssetRecord`. */
export interface AssetRecord {
  listed: boolean;
  tokenDecimals: bigint;
  depositsEnabled: boolean;
}

/** Solidity `IMulticall3.Call`. */
export interface Call {
  target: Address;
  callData: Hex;
}

/** Solidity `IMulticall3.Call3`. */
export interface Call3 {
  target: Address;
  allowFailure: boolean;
  callData: Hex;
}

/** Solidity `IMulticall3.Call3Value`. */
export interface Call3Value {
  target: Address;
  allowFailure: boolean;
  value: bigint;
  callData: Hex;
}

/** Solidity `ILuckyVault.Escrow`. */
export interface Escrow {
  asset: Address;
  amount: bigint;
  closesAt: bigint;
  registered: boolean;
  closed: boolean;
  released: boolean;
}

/** Solidity `PriceReader.Observation`. */
export interface Observation {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
}

/** Solidity `ILuckyDraw.PoolView`. */
export interface PoolView {
  id: bigint;
  asset: Address;
  enabled: boolean;
  buysPaused: boolean;
  nextPricing: PricingConfig;
  seedAmount: bigint;
  targetUsd: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
}

/** Solidity `PricingConfig`. */
export interface PricingConfig {
  feed: Address;
  feedDecimals: bigint;
  maxPriceAge: bigint;
  referenceKind: ReferenceKind;
  minAnswer: bigint;
  maxAnswer: bigint;
}

/** Solidity `ILuckyDraw.Quote`. */
export interface Quote {
  reason: QuoteReason;
  observation: Observation;
  minGross: bigint;
  feeDelta: bigint;
  netDelta: bigint;
  shareNumeratorBefore: bigint;
  shareDenominatorBefore: bigint;
  shareNumeratorAfter: bigint;
  shareDenominatorAfter: bigint;
  usdValueBefore: bigint;
  usdValueAfter: bigint;
  reachesTarget: boolean;
  closesAt: bigint;
}

/** Solidity `Range`. */
export interface Range {
  buyer: Address;
  cumulativeGross: bigint;
}

/** Solidity `IMulticall3.Result`. */
export interface Result {
  success: boolean;
  returnData: Hex;
}

/** Solidity `ILuckyDraw.RoundView`. */
export interface RoundView {
  id: bigint;
  poolId: bigint;
  kind: Kind;
  sequence: bigint;
  asset: Address;
  tokenDecimals: bigint;
  pricing: PricingConfig;
  feeAccount: Address;
  opensAt: bigint;
  closesAt: bigint;
  targetUsd: bigint;
  state: State;
  grossTotal: bigint;
  feeReserved: bigint;
  prizePot: bigint;
  playerCount: bigint;
  seeded: boolean;
  seedAccount: Address;
  seedGross: bigint;
  closedAt: bigint;
  closeReason: CloseReason;
  requestDeadline: bigint;
  requestId: bigint;
  requestedAt: bigint;
  word0: bigint;
  word1: bigint;
  winningIndex: bigint;
  winner: Address;
  settledAt: bigint;
  refundedGross: bigint;
  refundReason: RefundReason;
  rangeCount: bigint;
}

// ---------------------------------------------------------------------------
// Event argument records (SPEC §8.2). Indexed and non-indexed fields alike.
// ---------------------------------------------------------------------------

/** Arguments of `AssetListed(address,uint8)`. */
export interface AssetListedArgs {
  asset: Address;
  tokenDecimals: bigint;
}

/** Arguments of `BuysPausedSet(address,bool,bool)`. */
export interface BuysPausedSetArgs {
  actor: Address;
  oldValue: boolean;
  newValue: boolean;
}

/** Arguments of `CallbackIgnored(uint256,uint8)`. */
export interface CallbackIgnoredArgs {
  requestId: bigint;
  reason: CallbackIgnoreReason;
}

/** Arguments of `Deposited(address,address,uint256)`. */
export interface DepositedArgs {
  user: Address;
  asset: Address;
  amount: bigint;
}

/** Arguments of `DepositsEnabledSet(address,address,bool,bool)`. */
export interface DepositsEnabledSetArgs {
  asset: Address;
  actor: Address;
  oldValue: boolean;
  newValue: boolean;
}

/** Arguments of `DepositsPausedSet(address,bool,bool)`. */
export interface DepositsPausedSetArgs {
  actor: Address;
  oldValue: boolean;
  newValue: boolean;
}

/** Arguments of `DrawBound(address,address)`. */
export interface DrawBoundArgs {
  draw: Address;
  actor: Address;
}

/** Arguments of `DrawRequested(uint256,uint256,uint64)`. */
export interface DrawRequestedArgs {
  roundId: bigint;
  requestId: bigint;
  requestedAt: bigint;
}

/** Arguments of `EntryBought(uint256,address,uint256,uint256,uint256,uint256,uint80,int256,uint64)`. */
export interface EntryBoughtArgs {
  roundId: bigint;
  buyer: Address;
  gross: bigint;
  feeDelta: bigint;
  netDelta: bigint;
  cumulativeGross: bigint;
  oracleRoundId: bigint;
  priceAnswer: bigint;
  priceUpdatedAt: bigint;
}

/** Arguments of `FeeAccountSet(address,address,address)`. */
export interface FeeAccountSetArgs {
  actor: Address;
  oldValue: Address;
  newValue: Address;
}

/** Arguments of `FundsLocked(uint256,address,address,uint256)`. */
export interface FundsLockedArgs {
  roundId: bigint;
  user: Address;
  asset: Address;
  gross: bigint;
}

/** Arguments of `FundsReleased(uint256,address,address,uint256,uint8)`. */
export interface FundsReleasedArgs {
  roundId: bigint;
  recipient: Address;
  asset: Address;
  amount: bigint;
  reason: ReleaseReason;
}

/** Arguments of `NextPricingSet(uint256,address,(address,uint8,uint32,uint8,int256,int256),(address,uint8,uint32,uint8,int256,int256))`. */
export interface NextPricingSetArgs {
  poolId: bigint;
  actor: Address;
  oldValue: PricingConfig;
  newValue: PricingConfig;
}

/** Arguments of `OwnershipTransferStarted(address,address)`. */
export interface OwnershipTransferStartedArgs {
  previousOwner: Address;
  newOwner: Address;
}

/** Arguments of `OwnershipTransferred(address,address)`. */
export interface OwnershipTransferredArgs {
  previousOwner: Address;
  newOwner: Address;
}

/** Arguments of `PoolAdded(uint256,address,address,uint8,(address,uint8,uint32,uint8,int256,int256),uint256,uint32[7])`. */
export interface PoolAddedArgs {
  poolId: bigint;
  asset: Address;
  actor: Address;
  tokenDecimals: bigint;
  pricing: PricingConfig;
  seedAmount: bigint;
  targetUsd: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint];
}

/** Arguments of `PoolBuysPausedSet(uint256,address,bool,bool)`. */
export interface PoolBuysPausedSetArgs {
  poolId: bigint;
  actor: Address;
  oldValue: boolean;
  newValue: boolean;
}

/** Arguments of `PoolEnabledSet(uint256,address,bool,bool)`. */
export interface PoolEnabledSetArgs {
  poolId: bigint;
  actor: Address;
  oldValue: boolean;
  newValue: boolean;
}

/** Arguments of `RandomnessReceived(uint256,uint256,uint256,uint256)`. */
export interface RandomnessReceivedArgs {
  roundId: bigint;
  requestId: bigint;
  word0: bigint;
  word1: bigint;
}

/** Arguments of `Refunded(uint256,address,uint256)`. */
export interface RefundedArgs {
  roundId: bigint;
  user: Address;
  gross: bigint;
}

/** Arguments of `RoundClosed(uint256,uint8,uint8,uint64,uint64,uint256,uint256,uint256,uint256)`. */
export interface RoundClosedArgs {
  roundId: bigint;
  state: State;
  closeReason: CloseReason;
  closedAt: bigint;
  requestDeadline: bigint;
  grossTotal: bigint;
  prizePot: bigint;
  feeReserved: bigint;
  playerCount: bigint;
}

/** Arguments of `RoundEscrowClosed(uint256)`. */
export interface RoundEscrowClosedArgs {
  roundId: bigint;
}

/** Arguments of `RoundOpened(uint256,uint256,uint8,uint256,address,uint8,uint64,uint64,uint32,address,(address,uint8,uint32,uint8,int256,int256))`. */
export interface RoundOpenedArgs {
  roundId: bigint;
  poolId: bigint;
  kind: Kind;
  sequence: bigint;
  asset: Address;
  tokenDecimals: bigint;
  opensAt: bigint;
  closesAt: bigint;
  targetUsd: bigint;
  feeAccount: Address;
  pricing: PricingConfig;
}

/** Arguments of `RoundRefunding(uint256,uint8)`. */
export interface RoundRefundingArgs {
  roundId: bigint;
  reason: RefundReason;
}

/** Arguments of `RoundRegistered(uint256,address)`. */
export interface RoundRegisteredArgs {
  roundId: bigint;
  asset: Address;
}

/** Arguments of `RoundSettled(uint256,address,uint256,uint256,uint256,uint256,address,uint64)`. */
export interface RoundSettledArgs {
  roundId: bigint;
  winner: Address;
  requestId: bigint;
  winningIndex: bigint;
  prize: bigint;
  fee: bigint;
  feeAccount: Address;
  settledAt: bigint;
}

/** Arguments of `SeedAccountSet(address,address,address)`. */
export interface SeedAccountSetArgs {
  actor: Address;
  oldValue: Address;
  newValue: Address;
}

/** Arguments of `SeedAmountSet(uint256,address,uint256,uint256)`. */
export interface SeedAmountSetArgs {
  poolId: bigint;
  actor: Address;
  oldValue: bigint;
  newValue: bigint;
}

/** Arguments of `SeedAuthorized(address,address,uint256,uint256)`. */
export interface SeedAuthorizedArgs {
  account: Address;
  asset: Address;
  oldMaxPerRound: bigint;
  newMaxPerRound: bigint;
}

/** Arguments of `SeedEntered(uint256,address,uint256,uint256,uint256,uint256)`. */
export interface SeedEnteredArgs {
  roundId: bigint;
  seedAccount: Address;
  gross: bigint;
  feeDelta: bigint;
  netDelta: bigint;
  cumulativeGross: bigint;
}

/** Arguments of `SeedSkipped(uint256,uint8)`. */
export interface SeedSkippedArgs {
  roundId: bigint;
  reason: SeedSkipReason;
}

/** Arguments of `TargetUsdSet(uint256,uint8,address,uint32,uint32)`. */
export interface TargetUsdSetArgs {
  poolId: bigint;
  kind: Kind;
  actor: Address;
  oldValue: bigint;
  newValue: bigint;
}

/** Arguments of `Withdrawn(address,address,uint256)`. */
export interface WithdrawnArgs {
  user: Address;
  asset: Address;
  amount: bigint;
}

// ---------------------------------------------------------------------------
// Event topics and custom-error selectors, computed at generation time so a consumer can check
// completeness without instantiating an ethers Interface (SPEC §8.1, §10.1).
// ---------------------------------------------------------------------------

export const vaultEventTopics = {
  AssetListed: "0x279b53d62f47bd23dfadd7982464b00fa85148a019262e19ac7aee1f87619841",
  Deposited: "0x8752a472e571a816aea92eec8dae9baf628e840f4929fbcc2d155e6233ff68a7",
  DepositsEnabledSet: "0xaa23f0ea53112f79fec8a20a86b135f91fb55c58abdabe85a608f5c1c6d09e73",
  DepositsPausedSet: "0x076b1ec4989fa39efbac9878f8c739fad5bc33b16c14ae79bd7d491f4e6860b9",
  DrawBound: "0xa1bd07517434faebf564a89bd7dad1a36ad7b624fd1831ce9b996bfb5c9e1531",
  FundsLocked: "0x7095a30abb52211f453208acd965f61d0dee4bb3ba2695453309f77245c95b6d",
  FundsReleased: "0xf20019fafd43304ea3458d1e90d76013fbfd793d4fbfc3dd58ac1cd651b2ec39",
  OwnershipTransferStarted: "0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700",
  OwnershipTransferred: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
  RoundEscrowClosed: "0x31e0d49877461497c56556b85f43a05e8a224a5fdf8082f3bf0b42064f8582c4",
  RoundRegistered: "0x2250594ba968858970077938489521b5007c0be3976e201e97920aa7fbdd719b",
  SeedAuthorized: "0x13c36af969c397f564598c00572b3aeb0b69780eaf1ce87d3b67b01e327a3a3b",
  Withdrawn: "0xd1c19fbcd4551a5edfb66d43d2e337c04837afda3482b42bdf569a8fccdae5fb",
} as const;
export type VaultEventName = keyof typeof vaultEventTopics;

/** Event name to its argument record, so a decoder can be typed by name. */
export interface VaultEventArgsByName {
  AssetListed: AssetListedArgs;
  Deposited: DepositedArgs;
  DepositsEnabledSet: DepositsEnabledSetArgs;
  DepositsPausedSet: DepositsPausedSetArgs;
  DrawBound: DrawBoundArgs;
  FundsLocked: FundsLockedArgs;
  FundsReleased: FundsReleasedArgs;
  OwnershipTransferStarted: OwnershipTransferStartedArgs;
  OwnershipTransferred: OwnershipTransferredArgs;
  RoundEscrowClosed: RoundEscrowClosedArgs;
  RoundRegistered: RoundRegisteredArgs;
  SeedAuthorized: SeedAuthorizedArgs;
  Withdrawn: WithdrawnArgs;
}

export const drawEventTopics = {
  BuysPausedSet: "0xd9f1e98e0708c66a0f74513199a339937f5b2afa883dfb15fca04fb91a0d02f4",
  CallbackIgnored: "0x44695dd431ed1a00afee9541bde253cc42ea621b939feba0482455c947623c3d",
  DrawRequested: "0xf2ca910f52fef259d03fb31807399580465342b9a5e3e5e1760463a987164d4f",
  EntryBought: "0xb4eaaf145907b35471d223929ea86786d77337a50dcf4e7effa0a81572590538",
  FeeAccountSet: "0x4216268b23073f0e1fe8e6b6467cda878be484cd4e0a8baba5697e7d420a555f",
  NextPricingSet: "0xf47cf33dc24415735c51c6c9d5676e91fcadbd925beeb620829e6c621b8cde09",
  OwnershipTransferStarted: "0x38d16b8cac22d99fc7c124b9cd0de2d3fa1faef420bfe791d8c362d765e22700",
  OwnershipTransferred: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
  PoolAdded: "0x3077de5ed607c64c26ee1962c2b13253e17918bb7b00fb592632b6b6fc3aed6f",
  PoolBuysPausedSet: "0xeb7de0eb7d9ba01632c5ab9b2f8b48df4e0191f212a8f81d9870045260f1960e",
  PoolEnabledSet: "0x89738f9c64a6a1731b2eb58ee0c4c0a04d599440506633552f8e8e056c10a1e8",
  RandomnessReceived: "0xb550ef9eef701688522e39e5869350d8dceb0b96a637ffbaec4ee7a51a687c79",
  Refunded: "0x7ca5472b7ea78c2c0141c5a12ee6d170cf4ce8ed06be3d22c8252ddfc7a6a2c4",
  RoundClosed: "0xa154874491b0a279cb3b13ec540ec84145c405b04dcd223f55d0f9ae11f6b597",
  RoundOpened: "0xb6fe179e775daf0ddffe7bb2cd5c9e6cb5f17673c2c39dbec22cf6ca3192b9fa",
  RoundRefunding: "0xb5fbcdf1e82478d81cb6347ef38bbd8bde26f5815542a3e241ef61fb66423dd3",
  RoundSettled: "0x7bad67256822808d4fb74b463b4989eef913c6d1ec55ed834ebfaf5c1354f461",
  SeedAccountSet: "0x3acffdfc6c97a25c91785efc2ce907ed77420d5caa9cf9dd178090f8629ac1b7",
  SeedAmountSet: "0xa8f26485712625723185a5d3d2556e14b3fca2c45b6d6bac0895576fc8c70a23",
  SeedEntered: "0x289f44df5207f7d95e894943757d981bd56fcac044a1586ce90b85a5e902f8a6",
  SeedSkipped: "0xe2dfd521eecd143b2605e64b7a37f6c54dc6b5715843db56c6d7fcf3cdee900d",
  TargetUsdSet: "0x80e00ca21f2bc31f818cdd5472f756df3d8dd69d6bac61d5c0e86611d13facb5",
} as const;
export type DrawEventName = keyof typeof drawEventTopics;

/** Event name to its argument record, so a decoder can be typed by name. */
export interface DrawEventArgsByName {
  BuysPausedSet: BuysPausedSetArgs;
  CallbackIgnored: CallbackIgnoredArgs;
  DrawRequested: DrawRequestedArgs;
  EntryBought: EntryBoughtArgs;
  FeeAccountSet: FeeAccountSetArgs;
  NextPricingSet: NextPricingSetArgs;
  OwnershipTransferStarted: OwnershipTransferStartedArgs;
  OwnershipTransferred: OwnershipTransferredArgs;
  PoolAdded: PoolAddedArgs;
  PoolBuysPausedSet: PoolBuysPausedSetArgs;
  PoolEnabledSet: PoolEnabledSetArgs;
  RandomnessReceived: RandomnessReceivedArgs;
  Refunded: RefundedArgs;
  RoundClosed: RoundClosedArgs;
  RoundOpened: RoundOpenedArgs;
  RoundRefunding: RoundRefundingArgs;
  RoundSettled: RoundSettledArgs;
  SeedAccountSet: SeedAccountSetArgs;
  SeedAmountSet: SeedAmountSetArgs;
  SeedEntered: SeedEnteredArgs;
  SeedSkipped: SeedSkippedArgs;
  TargetUsdSet: TargetUsdSetArgs;
}

export const vaultErrorSelectors = {
  AlreadyBound: "0x682a9065",
  AlreadyListed: "0xa3d582ec",
  DepositsDisabled: "0x717a1648",
  DepositsPaused: "0xdeeb6943",
  EntryWindowClosed: "0x59a76ac4",
  EscrowClosed: "0xc6740195",
  InsufficientBalance: "0xf4d678b8",
  InvalidAmount: "0x2c5211c6",
  InvalidAsset: "0xc891add2",
  InvalidConfig: "0x35be3ac8",
  InvalidId: "0xdfa1a408",
  InvalidRecipient: "0x9c8d2cd2",
  OwnableInvalidOwner: "0x1e4fbdf7",
  OwnableUnauthorizedAccount: "0x118cdaa7",
  ReentrancyGuardReentrantCall: "0x3ee5aeb5",
  RefundExceedsLocked: "0xfc89d1b8",
  SafeERC20FailedOperation: "0x5274afe7",
  SeedAccountCannotBuy: "0x07eafe3d",
  SeedAlreadyLocked: "0xe2c1095b",
  SeedCapExceeded: "0x34141ef4",
  SeedNotAuthorized: "0x655b1bbd",
  TransferFailed: "0x90b8ec18",
  TransferMismatch: "0xfdff204a",
  Unauthorized: "0x82b42900",
  WrongState: "0xde4168ba",
} as const;
export type VaultErrorName = keyof typeof vaultErrorSelectors;

export const drawErrorSelectors = {
  AlreadyClaimed: "0x646cf558",
  AlreadyListed: "0xa3d582ec",
  AlreadySeeded: "0x4313f1c8",
  BelowMinimum: "0x860b82a9",
  BuysPaused: "0xf7cdbb58",
  DeadlineExpired: "0x1ab7da6b",
  EntryWindowClosed: "0x59a76ac4",
  InsufficientSeedBalance: "0x9b73a542",
  InvalidAmount: "0x2c5211c6",
  InvalidAsset: "0xc891add2",
  InvalidConfig: "0x35be3ac8",
  InvalidId: "0xdfa1a408",
  InvalidKind: "0x2b79ed30",
  InvalidRecipient: "0x9c8d2cd2",
  InvalidRequestId: "0xba0514c0",
  KeyHashUnsupported: "0x05789a81",
  NetContributionTooLow: "0xa2cd7a7b",
  OwnableInvalidOwner: "0x1e4fbdf7",
  OwnableUnauthorizedAccount: "0x118cdaa7",
  PoolDisabled: "0x19d5b294",
  PriceDecimalsChanged: "0xf274f815",
  PriceInvalid: "0x2013535a",
  PriceStale: "0x28771d91",
  PriceUnavailable: "0xcb08be81",
  ReentrancyGuardReentrantCall: "0x3ee5aeb5",
  RequestWindowClosed: "0xda640d07",
  RequestWindowStillOpen: "0x3ab1f235",
  RoundNotClosed: "0x29e3b953",
  SeedAccountCannotBuy: "0x07eafe3d",
  SeedNotAuthorized: "0x655b1bbd",
  SeedNotConfigured: "0x8002c8fd",
  SubscriptionUnderfunded: "0x36136bfc",
  Unauthorized: "0x82b42900",
  WrongState: "0xde4168ba",
} as const;
export type DrawErrorName = keyof typeof drawErrorSelectors;

/**
 * The error names declared in contracts/src/Errors.sol. Anything else a Vault or Draw ABI declares comes
 * from a pinned dependency (OpenZeppelin's `OwnableUnauthorizedAccount`, `SafeERC20FailedOperation`,
 * `ReentrancyGuardReentrantCall`), which SPEC §8.1 allows the client to decode as a documented
 * dependency error. `src/errors/` uses this list to classify a decoded revert.
 */
export const projectErrorNames = [
  "InvalidId",
  "InvalidKind",
  "InvalidConfig",
  "InvalidAmount",
  "InvalidRecipient",
  "InvalidAsset",
  "Unauthorized",
  "AlreadyBound",
  "AlreadyListed",
  "AlreadyClaimed",
  "WrongState",
  "EntryWindowClosed",
  "RoundNotClosed",
  "RequestWindowClosed",
  "RequestWindowStillOpen",
  "DeadlineExpired",
  "DepositsPaused",
  "DepositsDisabled",
  "BuysPaused",
  "PoolDisabled",
  "InsufficientBalance",
  "TransferMismatch",
  "TransferFailed",
  "EscrowClosed",
  "RefundExceedsLocked",
  "SeedCapExceeded",
  "SeedAlreadyLocked",
  "SeedAccountCannotBuy",
  "PriceUnavailable",
  "PriceInvalid",
  "PriceStale",
  "PriceDecimalsChanged",
  "BelowMinimum",
  "NetContributionTooLow",
  "InvalidRequestId",
  "KeyHashUnsupported",
  "SubscriptionUnderfunded",
  "SeedNotConfigured",
  "SeedNotAuthorized",
  "InsufficientSeedBalance",
  "AlreadySeeded",
] as const;
export type ProjectErrorName = (typeof projectErrorNames)[number];
