// One pool, one tier, one card (SPEC §9.4 `/`).
//
// Everything the route table asks for and nothing it does not: the asset badge from the pinned manifest, the
// tier label ("USD 1,000 · draws when reached · latest Mon 00:00 UTC in 2 d 3 h"), the progress meter of the
// pot's reference value toward the target, the prize pot in asset units with an `≈ USD` line and "includes
// operator seed" when seeded, participants with the seed counted separately, the connected account's share,
// and exactly one Enter action (§9.1 X3).
//
// Two different numbers, deliberately: the meter tracks `grossTotal`, because the target test of §6.2 is on
// gross, while "Prize pot" is `prizePot` = gross - fee reserve (§5.2), because that is what the round pays.
//
// The card re-renders only when its `card` object changes, which happens only when the snapshot's block hash
// changes (§9.3): the countdown here is coarse ("in 2 d 3 h") and deliberately not a ticking clock, so a list
// of twelve cards is not twelve 1 Hz re-renders.

import {Link} from "react-router";
import {
  type CardState,
  coarseRemaining,
  playersExcludingSeed,
  remainingSeconds,
  shortCutoffLabel,
  usdWhole,
} from "../../lib/rounds/derive.ts";
import {credit, cutoffText, usdWholeText} from "../../lib/rounds/format.ts";
import type {PoolCard} from "../../lib/rounds/list.ts";
import {fill} from "../../strings/en.ts";
import {rounds} from "../../strings/rounds.ts";
import {AssetBadge, Card, StateBadge, type StateTone} from "../index.ts";
import {ProgressMeter, ShareMeter} from "./Meters.tsx";
import "./rounds.css";

const STATE_TONES: Readonly<Record<CardState, StateTone>> = {
  active: "accent",
  awaitingAction: "pending",
  disabled: "neutral",
  unavailable: "info",
};

const STATE_LABELS: Readonly<Record<CardState, string>> = {
  active: rounds.card.stateActive,
  awaitingAction: rounds.card.stateAwaitingAction,
  disabled: rounds.card.stateDisabled,
  unavailable: rounds.card.stateUnavailable,
};

const KIND_LABELS = [
  rounds.card.kinds.Day100,
  rounds.card.kinds.Day1k,
  rounds.card.kinds.Day10k,
  rounds.card.kinds.Week1k,
  rounds.card.kinds.Week10k,
  rounds.card.kinds.Week100k,
  rounds.card.kinds.Month100k,
] as const;

export type RoundCardProps = {
  card: PoolCard;
  /** Chain seconds now, from the snapshot and the monotonic ticker (`useChainNow`). */
  now: bigint;
  /** The deployment's chain id: every round link carries it (SPEC §9.4 `/round/:chainId/:roundId`). */
  chainId: bigint;
};

export function RoundCard({card, now, chainId}: RoundCardProps) {
  const {round, asset} = card;
  const decimals = asset?.decimals ?? round?.tokenDecimals ?? 18n;
  const symbol = asset?.symbol ?? "";
  const target = usdWholeText(card.targetUsd);
  const remaining = round === null ? 0n : remainingSeconds(round.closesAt, now);

  const tier =
    round === null
      ? fill(rounds.card.tierNoRound, {target})
      : remaining === 0n
        ? fill(rounds.card.tierClosed, {target, cutoff: shortCutoffLabel(card.kind, round.closesAt)})
        : fill(rounds.card.tier, {
            target,
            cutoff: shortCutoffLabel(card.kind, round.closesAt),
            remaining: coarseRemaining(remaining),
          });

  const players = round === null ? 0n : playersExcludingSeed(round);
  // "Prize pot" is the prize, which SPEC §5.2 defines as `grossTotal - feeReserved`; the gross belongs to the
  // progress meter, because §6.2 tests the *gross* against the target. Showing the gross here was the card
  // promising 3% more than the round can pay.
  const prizeUsd =
    round === null || card.price === null ? null : usdWhole(round, card.price.price, round.prizePot);

  return (
    <Card
      as="article"
      title={
        <span className="chip-row">
          {asset === null ? null : <AssetBadge asset={asset} />}
          <span>{KIND_LABELS[card.kind]}</span>
        </span>
      }
      aside={<StateBadge tone={STATE_TONES[card.state]} label={STATE_LABELS[card.state]} />}
    >
      <p className="round-card__tier" title={round === null ? undefined : cutoffText(round.closesAt)}>
        {tier}
      </p>

      <ProgressMeter
        usd={card.progress?.usd ?? null}
        target={card.targetUsd}
        filledBps={card.progress?.filledBps ?? null}
      />

      {round === null ? (
        <p className="muted">{card.state === "disabled" ? rounds.card.disabledBody : rounds.card.noRound}</p>
      ) : (
        <>
          <div className="round-card__row">
            <span className="muted small">{rounds.card.potLabel}</span>
            <span className="round-card__pot">{credit(round.prizePot, decimals, symbol)}</span>
          </div>
          <p className="small muted">
            {prizeUsd === null
              ? rounds.card.potUsdUnavailable
              : fill(rounds.card.potUsd, {usd: usdWholeText(prizeUsd)})}
          </p>
          {round.seeded ? <p className="small">{rounds.card.includesSeed}</p> : null}

          <p className="small">
            {players === 0n
              ? rounds.card.participantsNone
              : players === 1n
                ? rounds.card.participantsOne
                : fill(rounds.card.participants, {players: players.toString()})}
            {round.seeded ? ` ${rounds.card.seedSeparate}` : ""}
          </p>

          {card.position === null || card.position.gross === 0n ? (
            <p className="small muted">{rounds.card.yourShareNone}</p>
          ) : (
            <ShareMeter
              numerator={card.position.gross}
              denominator={round.grossTotal}
              label={rounds.card.yourShare}
            />
          )}

          {card.state === "unavailable" ? <p className="small muted">{rounds.card.unavailableBody}</p> : null}
        </>
      )}

      <div className="round-card__footer">
        {round === null ? null : (
          <Link
            className={card.state === "active" ? "button button--primary" : "button button--secondary"}
            to={`/round/${chainId}/${round.id}`}
          >
            {card.state === "active" ? rounds.card.enter : rounds.card.view}
          </Link>
        )}
      </div>
    </Card>
  );
}
