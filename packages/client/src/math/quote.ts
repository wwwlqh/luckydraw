/// Client-side mirror of `LuckyDraw.quoteBuy` for instant entry feedback (SPEC §5.1, §5.3, §8.1).
///
/// This preview is ADVISORY. The contract's `quoteBuy` and, finally, `buy` itself are the authority: the price
/// is re-read at execution, and a preview computed from a snapshot can be one block stale. Its purpose is
/// sub-100 ms feedback while the user types, so the entry panel never waits on an RPC round trip to say
/// "below the minimum" or "you don't have that much". It must never approve what `quoteBuy` would reject
/// ("no client-only minimum bypass", SPEC §11.2 Client/indexer), which is why the check order, the seed model
/// and the overflow conditions below follow `quoteBuy` statement by statement.

import {MAX_UINT256} from "./constants.ts";
import {feeOf} from "./fee.ts";
import {
  QUOTE_REASON,
  type QuoteReason,
  type QuoteReasonName,
  quoteReasonNameOf,
  ROUND_STATE,
  type RoundState,
} from "./localTypes.ts";
import {require_} from "./mathError.ts";
import {classifyObservation, minGrossRaw, type ObservationInput, tryUsdValueUint256} from "./price.ts";

/// The round fields `previewEntry` needs, all from one `getRound` snapshot (SPEC §10.1: one block).
export interface PreviewRound {
  /// Round id; zero means the round does not exist (`InvalidRound`).
  readonly id: bigint;
  /// Lifecycle state.
  readonly state: RoundState;
  /// Entry window start.
  readonly opensAt: bigint;
  /// Entry window end; the cutoff is exclusive.
  readonly closesAt: bigint;
  /// Frozen token decimals.
  readonly tokenDecimals: number;
  /// Frozen `PricingConfig.feedDecimals`.
  readonly feedDecimals: number;
  /// Frozen whole-USD target.
  readonly targetUsd: bigint;
  /// Cumulative gross entered so far.
  readonly grossTotal: bigint;
  /// `feeOf(grossTotal)`.
  readonly feeReserved: bigint;
  /// Distinct addresses that have entered, operator seed included.
  readonly playerCount: bigint;
  /// Whether the operator seed has already entered this round.
  readonly seeded: boolean;
}

/// The prospective buyer's position and Vault state.
export interface PreviewBuyer {
  /// `getPosition(roundId, user).grossByUser`.
  readonly grossByUser: bigint;
  /// The buyer's available Vault balance in the round's asset.
  readonly availableBalance: bigint;
  /// `Vault.seedMaxPerRound(user, round.asset)`: the cap for THIS round's asset, because seed consent is per
  /// asset (SPEC §5.4). Nonzero means the account is a seed Safe here and cannot buy in this round; the same
  /// account is an ordinary player in a pool of an asset it authorized nothing for, so a cap read for another
  /// asset must never be passed in.
  readonly seedMaxPerRound: bigint;
}

/// The operator seed configuration and consent for this round's pool (SPEC §5.4).
export interface PreviewSeed {
  /// `getSeedAccount()`; the zero address when unset.
  readonly account: string;
  /// The pool's `seedAmount` in raw units; zero disables seeding.
  readonly amount: bigint;
  /// `Vault.seedMaxPerRound(account, round.asset)`: the cap the account authorized in its own transaction for
  /// this round's asset (SPEC §5.4). A cap in another asset does not authorize this round's seed.
  readonly maxPerRound: bigint;
  /// The seed account's available Vault balance in the round's asset.
  readonly availableBalance: bigint;
  /// The seed account's gross in this round, used only to decide whether it adds a distinct address.
  readonly grossByUser: bigint;
}

/// Everything `previewEntry` reads. All of it comes from one snapshot plus the amount the user typed.
export interface EntryPreviewInput {
  /// The block timestamp the preview is evaluated against (the snapshot's timestamp, SPEC §10.1).
  readonly now: bigint;
  /// The round, or `undefined` when the id is unknown (`InvalidRound`).
  readonly round: PreviewRound | undefined;
  /// Gross raw units the user wants to enter, fee reserve included.
  readonly grossAmount: bigint;
  /// The feed observation for the round's frozen pricing config.
  readonly observation: ObservationInput;
  /// The prospective buyer.
  readonly buyer: PreviewBuyer;
  /// Global `buysPaused`.
  readonly buysPaused: boolean;
  /// The pool's `buysPaused`.
  readonly poolBuysPaused: boolean;
  /// The operator seed configuration, or `undefined` only when the snapshot established that no seed is
  /// configured for this pool (`getSeedAccount()` is zero or the pool's `seedAmount` is zero).
  ///
  /// Required, deliberately: `quoteBuy` reads the seed state from chain storage on every call, so a caller
  /// that simply omits it is not being conservative. Omitting a seed that would in fact enter leaves it out of
  /// `shareDenominatorAfter` — which over-states the buyer's share, up to "100%" for what is really half a pot
  /// — and out of `basePlayers`, which flips `reachesTarget` to false and hides the disclosure SPEC §5.3
  /// requires ("quoteBuy reports this in advance and the app discloses the higher network fee"). Read the five
  /// `PreviewSeed` fields in the same snapshot as the round.
  readonly seed: PreviewSeed | undefined;
}

/// The fields of the on-chain `Quote` struct (`ILuckyDraw.Quote`), plus the reason's name for logs.
///
/// The feed `observation` is not repeated here: the caller supplied it. Everything a rejected quote must not
/// project (`feeDelta`, `netDelta`, the post-buy share, both USD values and `reachesTarget`) is zero or false
/// whenever `reason` is not `None`, exactly as SPEC §8.1 requires; `closesAt`, the before-share and
/// `minGross` are still returned on a rejection, exactly as `quoteBuy` returns them, because the panel needs
/// them to show the new minimum and preserve the input (SPEC §3.2).
export interface EntryPreview {
  /// The first failing check, or `None`.
  readonly reason: QuoteReason;
  /// `reason`'s identifier; user-facing copy comes from `src/catalog/`, never from this string.
  readonly reasonName: QuoteReasonName;
  /// The USD 1 admission minimum at this price; zero when the observation is unusable.
  readonly minGross: bigint;
  /// Fee attributed to this purchase.
  readonly feeDelta: bigint;
  /// Prize-pot contribution of this purchase.
  readonly netDelta: bigint;
  /// The buyer's gross before the purchase.
  readonly shareNumeratorBefore: bigint;
  /// The round's gross before the purchase.
  readonly shareDenominatorBefore: bigint;
  /// The buyer's gross after the purchase.
  readonly shareNumeratorAfter: bigint;
  /// The round's gross after the purchase, pending operator seed included.
  readonly shareDenominatorAfter: bigint;
  /// Reference value of the pot before the purchase, in whole USD.
  readonly usdValueBefore: bigint;
  /// Reference value of the pot after the purchase, in whole USD.
  readonly usdValueAfter: bigint;
  /// True when this purchase would close the round as TargetReached (and open its successor).
  readonly reachesTarget: boolean;
  /// The round's cutoff.
  readonly closesAt: bigint;
}

/// Classification of a seed attempt, in the order SPEC §5.4 states (`LuckyDraw._seedStatus`).
export type SeedStatus =
  | "ok"
  | "notConfigured"
  | "notAuthorized"
  | "alreadySeeded"
  | "notOpen"
  | "insufficientSeedBalance";

/// Mirrors `LuckyDraw._seedStatus`: would an operator seed enter this round right now?
///
/// The order matters and is the contract's: not configured, then not authorized (the account's own
/// `authorizeSeed` cap for this round's asset is below the amount), then already seeded, then not Open or
/// at/after the cutoff, then short balance.
export function seedStatus(
  round: Pick<PreviewRound, "state" | "closesAt" | "seeded">,
  seed: PreviewSeed | undefined,
  now: bigint,
): SeedStatus {
  if (seed === undefined) return "notConfigured";
  if (seed.amount === 0n || isZeroAddress(seed.account)) return "notConfigured";
  if (seed.maxPerRound < seed.amount) return "notAuthorized";
  if (round.seeded) return "alreadySeeded";
  if (round.state !== ROUND_STATE.Open || now >= round.closesAt) return "notOpen";
  if (seed.availableBalance < seed.amount) return "insufficientSeedBalance";
  return "ok";
}

/// Advisory preview of a purchase; never throws for inadmissible input, exactly like `quoteBuy`
/// (SPEC §8.1, A32).
///
/// Check precedence, statement for statement from `quoteBuy` (SPEC §5.1, §5.3):
/// `InvalidRound` -> `EntryWindowClosed` -> `InvalidAmount` -> `BuysPaused` -> the observation class
/// (`PriceUnavailable` / `PriceDecimalsChanged` / `PriceInvalid` / `PriceStale`) -> `BelowMinimum` ->
/// `SeedAccountCannotBuy` -> `InsufficientBalance` -> `ArithmeticOverflow`.
///
/// Two things a client cannot see are modelled the way the contract models them:
/// - the fallback operator seed that `buy` enters before the first player purchase, so the quoted `feeDelta`,
///   `shareDenominatorAfter` and `reachesTarget` match execution (SPEC §5.4);
/// - the uint256 limits, so an amount that would panic on-chain reports `ArithmeticOverflow` here too.
///
/// There is no deadline check, because `quoteBuy` has none either: `buy`'s `DeadlineExpired` is a property of
/// the transaction the caller then builds (SPEC §5.3). Two malformed-snapshot inputs throw instead of
/// returning a reason, and both are cases where `quoteBuy` itself reverts: decimals outside 0-18
/// (`InvalidConfig` inside `PriceReader._scale`) and a `feeReserved` that is not `feeOf(grossTotal)`
/// (`Panic(0x11)` inside `_feeSplit`, on either subtraction). Neither can come from a real round.
export function previewEntry(input: EntryPreviewInput): EntryPreview {
  const {round} = input;
  if (round === undefined || round.id === 0n) return rejected(QUOTE_REASON.InvalidRound, 0n, 0n, 0n, 0n);

  const closesAt = round.closesAt;
  const shareNumeratorBefore = input.buyer.grossByUser;
  const shareDenominatorBefore = round.grossTotal;

  // The feed is read once, before the window and amount checks, so `minGross` is available for the panel even
  // on a rejected quote (SPEC §3.2: "below-minimum rejection must display the new minimum").
  // One clock, the way `quoteBuy` has one `block.timestamp`: the snapshot's timestamp decides both the entry
  // window and the price age, whatever `now` the caller left on the observation.
  const priceClass = classifyObservation({...input.observation, now: input.now});
  const price = priceClass === "ok" ? input.observation.answer : 0n;
  const minGross = price !== 0n ? minGrossRaw(round.tokenDecimals, round.feedDecimals, price) : 0n;

  const reject = (reason: QuoteReason): EntryPreview =>
    rejected(reason, minGross, shareNumeratorBefore, shareDenominatorBefore, closesAt);

  if (round.state !== ROUND_STATE.Open || input.now < round.opensAt || input.now >= round.closesAt) {
    return reject(QUOTE_REASON.EntryWindowClosed);
  }
  if (input.grossAmount === 0n) return reject(QUOTE_REASON.InvalidAmount);
  if (input.buysPaused || input.poolBuysPaused) return reject(QUOTE_REASON.BuysPaused);
  if (priceClass !== "ok") return reject(QUOTE_REASON[priceClass]);
  if (input.grossAmount < minGross) return reject(QUOTE_REASON.BelowMinimum);
  // `quoteBuy` reads `VAULT.seedMaxPerRound(user, round.asset)`: the rule is per asset, so the caller must
  // supply the cap for this round's asset and nothing else (see `PreviewBuyer.seedMaxPerRound`).
  if (input.buyer.seedMaxPerRound !== 0n) return reject(QUOTE_REASON.SeedAccountCannotBuy);
  if (input.buyer.availableBalance < input.grossAmount) return reject(QUOTE_REASON.InsufficientBalance);

  // Rejected input must not reach projection arithmetic, even for a huge supplied amount.
  if (input.grossAmount > MAX_UINT256 - round.grossTotal) return reject(QUOTE_REASON.ArithmeticOverflow);

  // Model the seed `buy` would enter first, so the quoted split and target flag match execution (SPEC §5.4).
  let baseGross = round.grossTotal;
  let baseFee = round.feeReserved;
  let basePlayers = round.playerCount;
  if (!round.seeded) {
    const seed = input.seed;
    if (seed !== undefined && seedStatus(round, seed, input.now) === "ok") {
      if (seed.amount > MAX_UINT256 - baseGross - input.grossAmount) {
        return reject(QUOTE_REASON.ArithmeticOverflow);
      }
      baseGross += seed.amount;
      baseFee = feeOf(baseGross);
      if (seed.grossByUser === 0n) basePlayers += 1n;
    }
  }

  const postGross = baseGross + input.grossAmount;
  const before = tryUsdValueUint256(round.grossTotal, round.tokenDecimals, round.feedDecimals, price);
  const after = tryUsdValueUint256(postGross, round.tokenDecimals, round.feedDecimals, price);
  if (!before.ok || !after.ok) return reject(QUOTE_REASON.ArithmeticOverflow);

  // `_feeSplit(baseGross, baseFee, grossAmount)`: the fee is cumulative, so the split is measured against the
  // pot the purchase actually lands on, seed included.
  const feeDelta = feeOf(baseGross + input.grossAmount) - baseFee;
  // Both of the contract's subtractions are checked, and a `feeReserved` that does not match `grossTotal`
  // breaks one of them: above `feeOf(grossTotal)` panics on `mulDiv(...) - feeReserved`, below it panics on
  // `gross - feeDelta`. `quoteBuy` reverts with Panic(0x11) in both cases, so neither is displayed here.
  require_(feeDelta >= 0n, "InvalidInput", "feeReserved is above feeOf(grossTotal) in the round snapshot");
  require_(
    feeDelta <= input.grossAmount,
    "InvalidInput",
    "feeReserved is below feeOf(grossTotal) in the round snapshot",
  );
  const netDelta = input.grossAmount - feeDelta;
  if (input.buyer.grossByUser === 0n) basePlayers += 1n;

  return {
    reason: QUOTE_REASON.None,
    reasonName: quoteReasonNameOf(QUOTE_REASON.None),
    minGross,
    feeDelta,
    netDelta,
    shareNumeratorBefore,
    shareDenominatorBefore,
    shareNumeratorAfter: shareNumeratorBefore + input.grossAmount,
    shareDenominatorAfter: postGross,
    usdValueBefore: before.value,
    usdValueAfter: after.value,
    reachesTarget: basePlayers >= 2n && after.value >= round.targetUsd,
    closesAt,
  };
}

function rejected(
  reason: QuoteReason,
  minGross: bigint,
  shareNumeratorBefore: bigint,
  shareDenominatorBefore: bigint,
  closesAt: bigint,
): EntryPreview {
  return {
    reason,
    reasonName: quoteReasonNameOf(reason),
    minGross,
    feeDelta: 0n,
    netDelta: 0n,
    shareNumeratorBefore,
    shareDenominatorBefore,
    shareNumeratorAfter: 0n,
    shareDenominatorAfter: 0n,
    usdValueBefore: 0n,
    usdValueAfter: 0n,
    reachesTarget: false,
    closesAt,
  };
}

function isZeroAddress(account: string): boolean {
  return /^0x0{40}$/i.test(account);
}
