// The entry panel (SPEC §9.5 — every sentence of it is a requirement).
//
// The pipeline, and the reason each step exists:
//
//   readEntryPanel (the caller's block-keyed snapshot)
//     -> previewEntry               advisory, sub-100 ms, so typing never waits on an RPC round trip
//     -> a fresh readEntryPanel     the authority: the price is re-read and the quote is stamped with the
//                                   round, buyer and asset it answers for
//     -> entryFromQuote             refuses a quote read for another round, buyer, asset or amount, and
//                                   refuses when no deadline shorter than the cutoff remains
//     -> prepareBuy                 the only place `buy` calldata exists
//     -> useTransaction.send        estimates the full calldata, then opens the wallet for the quoted account
//
// Nothing in this component raises a debit on its own, and no step is skipped when the amount, the round or
// the account changes: `entryKey` invalidates the confirmed plan, and the panel returns to the preview. The
// plan is *derived* from what the panel currently asks for rather than simply stored, so a `readFresh` that
// resolves late cannot install one, and a plan whose own deadline the chain clock has passed stops being
// offered without any event to notice it.

import {
  type Address,
  catalogEntryFor,
  type EntryPanel as EntryPanelData,
  type ManifestAsset,
  type PreparedWrite,
  prepareBuy,
  QuoteReason,
  quoteReasonCatalogKey,
  renderMessage,
  type Snapshot,
  seedStatus,
} from "@luckydraw/client";
import {useCallback, useEffect, useId, useMemo, useRef, useState} from "react";
import {Link} from "react-router";
import {useDeployment} from "../../lib/deployment/DeploymentProvider.tsx";
import {type PriceState, remainingSeconds, usdCents} from "../../lib/rounds/derive.ts";
import {
  type EntryMode,
  entryKey,
  gasExceedsShare,
  grossUsdCents,
  inFinalSeconds,
  needsFreshPrice,
  parseEntryAmount,
  planFrom,
  planStillAgrees,
  presetGross,
  previewFor,
  USD_PRESETS,
} from "../../lib/rounds/entry.ts";
import {
  credit,
  cutoffText,
  debit,
  formatAmountFull,
  usdCentsText,
  usdWholeText,
  zoneText,
} from "../../lib/rounds/format.ts";
import type {FeeEstimate} from "../../lib/rounds/gas.ts";
import type {TransactionHandle} from "../../lib/tx/useTransaction.tsx";
import {useWriteGate} from "../../lib/wallet/useWriteGate.ts";
import {en, fill} from "../../strings/en.ts";
import {rounds} from "../../strings/rounds.ts";
import {Button, TxLiveRegion, TxStepper} from "../index.ts";
import {FeeBreakdown} from "./FeeBreakdown.tsx";
import {ShareMeter} from "./Meters.tsx";
import "./rounds.css";

const PARSE_MESSAGES: Readonly<Record<string, string>> = {
  empty: rounds.entry.parseEmpty,
  commaSeparator: rounds.entry.parseCommaSeparator,
  negative: rounds.entry.parseNegative,
  multipleDots: rounds.entry.parseMultipleDots,
  invalidCharacter: rounds.entry.parseInvalidCharacter,
  tooManyFractionDigits: rounds.entry.parseTooManyFractionDigits,
  aboveMaxUint256: rounds.entry.parseAboveMaxUint256,
  usdPrecision: rounds.entry.parseTooManyUsdDigits,
  noPrice: rounds.card.potUsdUnavailable,
};

/** A confirmed plan: the calldata and the disclosures the fresh quote produced, bound to what it answers for. */
type Plan = {
  key: string;
  /** The account the quote was read for. `confirm` signs for this one or for nobody (SPEC §9.5). */
  account: Address;
  prepared: PreparedWrite;
  gross: bigint;
  feeDelta: bigint;
  netDelta: bigint;
  shareNumeratorAfter: bigint;
  shareDenominatorAfter: bigint;
  reachesTarget: boolean;
  fallbackSeedGross: bigint;
  deadline: bigint;
  fee: FeeEstimate | null;
};

export type EntryPanelProps = {
  panel: EntryPanelData;
  /** The block-keyed snapshot the panel was read at; its timestamp is the clock for every check. */
  now: bigint;
  account: Address | null;
  asset: ManifestAsset | null;
  price: PriceState;
  /** Re-runs the caller's snapshot read, for the price auto-refresh of SPEC §9.5. */
  refresh: () => void;
  /** A fresh `readEntryPanel` for one exact gross, taken immediately before signing. */
  readFresh: (gross: bigint) => Promise<Snapshot<EntryPanelData>>;
  /** Estimates the network fee for the prepared calldata; null when the node will not answer. */
  estimateFee?: ((prepared: PreparedWrite, account: Address) => Promise<FeeEstimate | null>) | undefined;
  /** The native asset's reference price, for converting the gas estimate to USD (SPEC §9.5). */
  nativeReference?: {price: bigint; feedDecimals: number} | null;
  /** The chain's native currency symbol, in which a network fee is denominated. */
  nativeSymbol: string;
  /** The transaction handle this surface owns. */
  tx: TransactionHandle;
  /** The pool and kind's current round, offered after an `EntryWindowClosed` revert (SPEC §9.5). */
  successorRoundId: bigint;
  chainId: bigint;
};

export function EntryPanel(props: EntryPanelProps) {
  const {panel, now, account, asset, price, refresh, readFresh, tx, successorRoundId, chainId} = props;
  const {verified, chain} = useDeployment();
  const gate = useWriteGate();
  const fieldId = useId();
  const [mode, setMode] = useState<EntryMode>("asset");
  const [text, setText] = useState("");
  const [stored, setStored] = useState<Plan | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  // The Review-time twin of the `EntryWindowClosed` revert: a fresh quote can report the window shut before
  // anything is signed, and §9.5 says the app offers the new round in exactly that case too.
  const [closedNow, setClosedNow] = useState(false);

  const round = panel.round;
  const decimals = round.tokenDecimals;
  const symbol = asset?.symbol ?? "";
  const shape = useMemo(
    () => ({tokenDecimals: Number(round.tokenDecimals), feedDecimals: Number(round.pricing.feedDecimals)}),
    [round.tokenDecimals, round.pricing.feedDecimals],
  );

  const parsed = useMemo(
    () => (text.trim() === "" ? null : parseEntryAmount(text, mode, shape, price.price)),
    [text, mode, shape, price.price],
  );
  const gross = parsed?.ok === true ? parsed.raw : 0n;
  const key = entryKey(round.id, account, gross);

  // What the panel answers for *now*, readable from inside an in-flight `review()`. A `readFresh` that
  // resolves after the amount or the account moved on compares against this and drops its own result, so a
  // late snapshot can never install a plan that the render below would then pair with the new gross.
  const keyRef = useRef(key);
  keyRef.current = key;

  // SPEC §9.5: "A new amount requires a fresh preview, and so does a new round or a new signing account."
  //
  // The stored plan is dropped here *and* disqualified at render below. Both are needed: the effect stops a
  // plan coming back to life when the user types the old amount again, and the derived form is what makes a
  // plan built for another key or an expired deadline unusable in the very render that notices it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the reset trigger, not a value read here.
  useEffect(() => {
    setStored(null);
    setRefusal(null);
    setClosedNow(false);
    setPreparing(false);
  }, [key]);

  const preview = useMemo(() => (gross === 0n ? null : previewFor(panel, gross, now)), [panel, gross, now]);

  const remaining = remainingSeconds(round.closesAt, now);
  const waitingForPrice = needsFreshPrice(price.ageSeconds, price.maxPriceAge);

  /**
   * The plan this render may act on.
   *
   * Derived rather than stored, because three things invalidate a plan without any event to hang an effect
   * on: the key can have moved on while `readFresh` was in flight (a late resolution cannot outrun a
   * render); the chain clock can have passed the quote's own `deadline`, after which `buy` reverts
   * `DeadlinePassed` and the disclosures describe a purchase that can no longer happen; and the panel keeps
   * re-reading underneath the plan (SPEC §10.1), so the round, the balance or the price can move until the
   * live preview no longer agrees with what the plan says this purchase does. In every case the panel falls
   * back to "Review entry" with the typed amount untouched (§9.1 X4: a failure keeps the user's input).
   */
  const forThisEntry = stored !== null && stored.key === key && now < stored.deadline;
  const agrees =
    stored !== null && preview !== null && planStillAgrees(stored, preview, {gross, balance: panel.balance});
  const plan: Plan | null = forThisEntry && agrees ? stored : null;
  /** A plan for this very entry that the live panel has since contradicted: say so, do not sign it. */
  const planMoved = forThisEntry && !agrees;

  // Auto-refresh while the observation is within 15 seconds of its age limit (SPEC §9.5).
  useEffect(() => {
    if (!waitingForPrice) return;
    const timer = setTimeout(refresh, 4_000);
    return () => clearTimeout(timer);
  }, [waitingForPrice, refresh]);

  // SPEC §10.1: the client "re-quotes on debounced input (300 ms) and every 10 seconds while the entry panel
  // is open" — while a plan is held too, because that is the only way the panel can notice that the round,
  // the balance or the price moved under a confirmation that is still on screen (`planStillAgrees` above).
  useEffect(() => {
    if (gross === 0n) return;
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [gross, refresh]);

  const review = useCallback(async () => {
    if (account === null || verified === null || gross === 0n) return;
    // The question this review answers. Every resolution below is discarded unless the panel is still asking
    // it: `readFresh` and `estimateFee` are both awaited, and the user can retype or switch account meanwhile.
    const plannedKey = entryKey(round.id, account, gross);
    const current = (): boolean => keyRef.current === plannedKey;
    setPreparing(true);
    setRefusal(null);
    try {
      const fresh = await readFresh(gross);
      if (!current()) return;
      const outcome = planFrom(fresh.value, {
        roundId: round.id,
        user: account,
        gross,
        chainTimestamp: fresh.timestamp,
      });
      if (!outcome.ok) {
        if (outcome.kind === "QuoteRejected" && outcome.reason === QuoteReason.EntryWindowClosed) {
          setClosedNow(true);
        }
        // A refused re-quote is the chain's answer about *this* amount, so whatever plan was held for it is
        // gone: a Confirm control must never stand beside the refusal that replaced its quote (§9.1 X2, X4).
        setStored(null);
        setRefusal(refusalText(outcome, fresh.value, symbol));
        return;
      }
      const prepared = prepareBuy(verified, outcome.params);
      const fee = props.estimateFee === undefined ? null : await props.estimateFee(prepared, account);
      if (!current()) return;
      setStored({
        key: plannedKey,
        account,
        prepared,
        gross,
        feeDelta: outcome.disclosures.feeDelta,
        netDelta: outcome.disclosures.netDelta,
        shareNumeratorAfter: outcome.disclosures.shareNumeratorAfter,
        shareDenominatorAfter: outcome.disclosures.shareDenominatorAfter,
        reachesTarget: outcome.disclosures.reachesTarget,
        fallbackSeedGross: outcome.disclosures.fallbackSeedGross,
        deadline: outcome.params.deadline,
        fee,
      });
    } catch (error) {
      if (!current()) return;
      setRefusal(error instanceof Error ? error.message : String(error));
    } finally {
      if (current()) setPreparing(false);
    }
  }, [account, verified, gross, readFresh, round.id, symbol, props.estimateFee]);

  // SPEC §9.5: "Every write must pass the account its quote was read for." The plan carries that account, so
  // the signer is asked for it and never for whichever account the wallet happens to hold at this instant; a
  // plan built for another account is refused outright rather than re-aimed.
  const confirm = useCallback(async () => {
    if (plan === null || account === null || plan.account !== account) return;
    await tx.send(plan.prepared, {
      account: plan.account,
      label: fill(rounds.entry.label, {roundId: round.id.toString()}),
    });
  }, [plan, account, tx, round.id]);

  const gasCents =
    plan?.fee == null || props.nativeReference == null
      ? null
      : usdCents(18, props.nativeReference.feedDecimals, props.nativeReference.price, plan.fee.feeWei);
  const grossCents = grossUsdCents(panel, price.price, gross);
  const gasWarning = gasExceedsShare(gasCents, grossCents);

  const failure = tx.state.failure;
  const stale = failure !== null && failure.catalogKey === "PriceStale";
  const windowClosed = closedNow || (failure !== null && failure.catalogKey === "EntryWindowClosed");

  const shortfall =
    preview !== null && preview.reason === QuoteReason.InsufficientBalance ? gross - panel.balance : 0n;
  const topUpHref =
    shortfall > 0n
      ? `/wallet?asset=${round.asset}&amount=${formatAmountFull(shortfall, Number(decimals))}&intent=${round.id}`
      : null;

  const lonePlayer = panel.position.gross > 0n && playersBesidesSeed(panel) === 1n;

  // SPEC §9.5 has one sentence for a seeded round and one for an unseeded pool. A configured seed that has
  // not entered yet is neither: it enters with this very purchase (the fallback seed of §5.4), so it is said
  // that way rather than claiming it is already in the pot (§9.1 X2).
  const seedStatusNow = seedStatus(panel.round, panel.seed ?? undefined, now);
  const seedSentence =
    panel.round.seeded && panel.seed !== null
      ? fill(rounds.entry.seeded, {amount: debit(panel.round.seedGross, decimals, symbol)})
      : seedStatusNow === "ok" && panel.seed !== null
        ? fill(rounds.entry.seedPending, {amount: debit(panel.seed.amount, decimals, symbol)})
        : rounds.entry.unseeded;

  // Exactly one sentence explains a disabled Review control, in the order the user can act on (§9.1 X4).
  // Review reads a quote; it does not move funds, so it needs only an account to quote for and a verified
  // deployment to build calldata from. The wallet gate itself belongs on Confirm, which is what signs.
  const reviewBlocked: string | null =
    account === null || verified === null
      ? (gate.reason ?? en.gate.verifying)
      : preview === null
        ? rounds.entry.parseEmpty
        : preview.reason !== QuoteReason.None
          ? quoteMessage(preview.reason, {
              min: debit(preview.minGross, decimals, symbol),
              symbol,
              available: credit(panel.balance, decimals, symbol),
              gross: debit(gross, decimals, symbol),
            })
          : waitingForPrice
            ? rounds.entry.priceWaiting
            : remaining === 0n
              ? rounds.entry.noTimeLeft
              : null;

  return (
    <section aria-label={rounds.entry.sheetLabel}>
      <TxLiveRegion state={tx.state} />
      <h2 className="card__title">{rounds.entry.heading}</h2>

      <div className="chip-row">
        <button
          type="button"
          className={mode === "asset" ? "button button--primary" : "button button--secondary"}
          aria-pressed={mode === "asset"}
          onClick={() => setMode("asset")}
        >
          {fill(rounds.entry.modeAsset, {symbol})}
        </button>
        <button
          type="button"
          className={mode === "usd" ? "button button--primary" : "button button--secondary"}
          aria-pressed={mode === "usd"}
          onClick={() => setMode("usd")}
        >
          {rounds.entry.modeUsd}
        </button>
      </div>

      <label htmlFor={fieldId}>{rounds.entry.amountLabel}</label>
      <div className="entry-field">
        <input
          id={fieldId}
          className="entry-field__input"
          inputMode="decimal"
          autoComplete="off"
          value={text}
          onChange={(event) => setText(event.target.value)}
          aria-describedby={`${fieldId}-hint`}
        />
        <Button
          variant="secondary"
          onClick={() => {
            setMode("asset");
            setText(formatAmountFull(panel.balance, Number(decimals)));
          }}
          aria-label={rounds.entry.maxHint}
        >
          {rounds.entry.max}
        </Button>
      </div>
      <p id={`${fieldId}-hint`} className="small muted">
        {mode === "asset" ? fill(rounds.entry.amountHintAsset, {symbol}) : rounds.entry.amountHintUsd} ·{" "}
        {rounds.entry.balance}: <span className="amount">{credit(panel.balance, decimals, symbol)}</span>
      </p>

      <fieldset className="entry-presets">
        <legend className="visually-hidden">{rounds.entry.presetsLabel}</legend>
        {USD_PRESETS.map((usd) => (
          <Button
            key={usd.toString()}
            variant="ghost"
            onClick={() => {
              const raw = presetGross(shape, price.price, usd);
              if (raw === null) return;
              setMode("asset");
              setText(formatAmountFull(raw, Number(decimals)));
            }}
          >
            {fill(rounds.entry.preset, {usd: usd.toString()})}
          </Button>
        ))}
      </fieldset>

      {parsed !== null && !parsed.ok ? (
        <p className="notice notice--warning small" role="alert">
          {fill(PARSE_MESSAGES[parsed.reason] ?? rounds.entry.parseInvalidCharacter, {
            symbol,
            decimals: decimals.toString(),
          })}
        </p>
      ) : null}

      {preview !== null && preview.reason !== QuoteReason.None ? (
        <p className="notice notice--warning small" role="status">
          {quoteMessage(preview.reason, {
            min: debit(preview.minGross, decimals, symbol),
            symbol,
            available: credit(panel.balance, decimals, symbol),
            gross: debit(gross, decimals, symbol),
          })}
        </p>
      ) : null}

      {topUpHref === null ? null : (
        <p className="small">
          {fill(rounds.entry.topUpBody, {
            available: credit(panel.balance, decimals, symbol),
            gross: debit(gross, decimals, symbol),
            shortfall: debit(shortfall, decimals, symbol),
          })}{" "}
          <Link to={topUpHref}>{rounds.entry.topUp}</Link>
        </p>
      )}

      {/*
        Every figure here is the live preview's, never the stored plan's: the panel goes on reading while a
        plan is held, so a plan's numbers and the balance beside them would otherwise come from two different
        blocks — "your share after" could read below "your share now", and "balance after" could describe a
        balance the account no longer has (§9.1 X1, X2). A plan whose own disclosures no longer match these
        is not held at all (`planStillAgrees`), so while Confirm is offered the two are the same numbers.
      */}
      {preview !== null && preview.reason === QuoteReason.None ? (
        <>
          <FeeBreakdown
            gross={gross}
            feeDelta={preview.feeDelta}
            netDelta={preview.netDelta}
            balanceAfter={panel.balance - gross}
            decimals={decimals}
            symbol={symbol}
          />
          <ShareMeter
            numerator={preview.shareNumeratorBefore}
            denominator={preview.shareDenominatorBefore}
            label={rounds.entry.shareBefore}
          />
          <ShareMeter
            numerator={preview.shareNumeratorAfter}
            denominator={preview.shareDenominatorAfter}
            label={rounds.entry.shareAfter}
          />
        </>
      ) : null}

      <ul className="entry-facts" aria-label={rounds.entry.disclosuresLabel}>
        <li>
          {fill(rounds.entry.priceAge, {
            age: `${price.ageSeconds} s`,
            max: `${price.maxPriceAge} s`,
          })}
        </li>
        <li>
          {fill(rounds.entry.cutoff, {cutoff: cutoffText(round.closesAt)})} ·{" "}
          {fill(rounds.entry.zone, {zone: zoneText(round.closesAt)})}
        </li>
        <li>{seedSentence}</li>
        <li>{rounds.entry.final}</li>
        <li>{rounds.entry.tenMinutes}</li>
        <li>{rounds.entry.acceptedRequest}</li>
        <li>{rounds.entry.chance}</li>
        <li>
          {/*
            The fee itself is the wallet's estimate in the native asset and stands on its own; only the USD
            conversion depends on the native price reference. When that reference is not usable the line says
            so instead of printing a confident "≈ USD" (§9.1 X2) — and `gasExceedsShare` has nothing to
            compare, so the 25% warning below stays silent rather than firing on a number nobody can check.
          */}
          {plan?.fee == null
            ? rounds.entry.gasUnavailable
            : `${fill(rounds.entry.gas, {gas: credit(plan.fee.feeWei, 18, props.nativeSymbol)})} (${
                gasCents === null
                  ? rounds.card.potUsdUnavailable
                  : fill(rounds.entry.gasUsd, {usd: usdCentsText(gasCents)})
              }) — ${rounds.entry.gasLabel}`}
        </li>
        {lonePlayer ? (
          <li>{round.seeded ? rounds.round.lonePlayerSeeded : rounds.round.lonePlayerUnseeded}</li>
        ) : null}
      </ul>

      {gasWarning ? (
        <p className="notice notice--warning small" role="status">
          {rounds.entry.gasWarning}
        </p>
      ) : null}

      {inFinalSeconds(remaining) ? (
        <p className="notice notice--warning small" role="status">
          {rounds.entry.finalSeconds}
        </p>
      ) : null}

      {preview?.reachesTarget === true ? (
        <p className="notice notice--info small">
          {fill(rounds.entry.reachesTarget, {target: usdWholeText(round.targetUsd)})}
          {plan?.fee == null
            ? ""
            : ` ${fill(rounds.entry.reachesTargetGas, {gas: credit(plan.fee.feeWei, 18, props.nativeSymbol)})}`}
        </p>
      ) : null}

      {plan !== null && plan.fallbackSeedGross > 0n ? (
        <p className="notice notice--info small">
          {fill(rounds.entry.fallbackSeed, {amount: debit(plan.fallbackSeedGross, decimals, symbol)})}
        </p>
      ) : null}

      {waitingForPrice ? (
        <p className="notice notice--info small" role="status">
          {rounds.entry.priceWaiting}
        </p>
      ) : null}

      {planMoved ? (
        <p className="notice notice--warning small" role="status">
          {rounds.entry.planMoved}
        </p>
      ) : null}

      {refusal === null ? null : (
        <p className="notice notice--error small" role="alert">
          {refusal}
        </p>
      )}

      {failure === null ? null : (
        <p className="notice notice--error small" role="alert">
          {failure.message} {failure.funds}. {failure.nextAction}.
        </p>
      )}

      {windowClosed && successorRoundId !== 0n ? (
        <p className="small">
          <Link to={`/round/${chainId}/${successorRoundId}`}>{rounds.round.successorLink}</Link>
        </p>
      ) : null}

      <TxStepper state={tx.state} chain={chain} />

      <div className="round-card__footer">
        {plan === null ? (
          <Button
            variant="primary"
            block
            loading={preparing}
            disabledReason={reviewBlocked}
            onClick={() => void review()}
          >
            {rounds.entry.review}
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              block
              loading={tx.busy}
              disabledReason={gate.allowed ? null : gate.reason}
              onClick={() => void confirm()}
            >
              {tx.busy ? rounds.entry.confirming : rounds.entry.confirm}
            </Button>
            <Button variant="ghost" onClick={() => setStored(null)}>
              {rounds.entry.edit}
            </Button>
          </>
        )}
        {stale ? (
          <Button
            variant="secondary"
            onClick={() => {
              tx.reset();
              void review();
            }}
          >
            {rounds.entry.retrySameAmount}
          </Button>
        ) : null}
      </div>

      <p className="small muted">
        {rounds.entry.responsible} <Link to="/help">{rounds.entry.responsibleLink}</Link>
      </p>
      <p className="smallest muted">{en.tx.neverResend}</p>
    </section>
  );
}

/** Distinct player addresses in this round, with the operator seed counted separately (SPEC §9.8). */
function playersBesidesSeed(panel: EntryPanelData): bigint {
  const players = panel.round.seeded ? panel.round.playerCount - 1n : panel.round.playerCount;
  return players > 0n ? players : 0n;
}

/**
 * The client catalog's sentence for a quote reason, with the money placeholders already formatted.
 *
 * SPEC §9.6 keeps the wording in the catalog and the formatting in `src/format`, so this function is the only
 * join between them on this surface; a reason from a newer deployment than this client knows falls back to
 * the generic sentence rather than printing a number.
 */
function quoteMessage(reason: QuoteReason, params: Readonly<Record<string, string>>): string {
  const key = quoteReasonCatalogKey(reason);
  if (key === undefined) return rounds.entry.quoteStale;
  return renderMessage(catalogEntryFor(key), params);
}

/** Why `entryFromQuote` refused, in plain words (SPEC §9.1 X4: a refusal names its cause). */
function refusalText(
  outcome: Exclude<ReturnType<typeof planFrom>, {ok: true}>,
  panel: EntryPanelData,
  symbol: string,
): string {
  switch (outcome.kind) {
    case "QuoteRejected":
      return quoteMessage(outcome.reason, {
        min: debit(panel.quote.minGross, panel.round.tokenDecimals, symbol),
        symbol,
        available: credit(panel.balance, panel.round.tokenDecimals, symbol),
        gross: debit(panel.quote.feeDelta + panel.quote.netDelta, panel.round.tokenDecimals, symbol),
      });
    case "NoTimeRemaining":
      return rounds.entry.noTimeLeft;
    default:
      // A quote for another round, buyer, asset or amount: the preview no longer describes this purchase.
      return rounds.entry.quoteStale;
  }
}
