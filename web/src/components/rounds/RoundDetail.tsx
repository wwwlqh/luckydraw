// The body of `/round/:chainId/:roundId` (SPEC §9.4 route table, §9.6 state table).
//
// Presentational on purpose: everything it needs arrives as props, so every state of the §9.6 table can be
// rendered from a fixture and asserted without a node, a wallet or a clock. `Round.tsx` owns the reads, the
// transactions and the entry pipeline and passes the entry panel in as a child.
//
// Order follows the route table: header, target progress, status timeline, pot card, entry panel (a bottom
// sheet under 600 px), your position, holders, entry ledger, result or refund card, the fee and odds
// explanation and the Verify link.

import {type Address, type ManifestAsset, type Position, type Range, State} from "@luckydraw/client";
import {type ReactNode, useMemo, useState} from "react";
import {Link} from "react-router";
import {
  lifecycleOf,
  type PriceState,
  playersExcludingSeed,
  remainingSeconds,
  targetProgressOf,
  timelineOf,
  usdWhole,
} from "../../lib/rounds/derive.ts";
import {credit, cutoffText, formatShare, usdWholeText} from "../../lib/rounds/format.ts";
import {aggregateHolders, ledgerOf, type RoundData} from "../../lib/rounds/round.ts";
import type {TransactionHandle} from "../../lib/tx/useTransaction.tsx";
import {fill} from "../../strings/en.ts";
import {rounds} from "../../strings/rounds.ts";
import {AssetBadge, Button, Card, Disclosures, EmptyState, JurisdictionNotice, StateBadge} from "../index.ts";
import {Countdown} from "./Countdown.tsx";
import {EntryLedger} from "./EntryLedger.tsx";
import {HoldersTable} from "./HoldersTable.tsx";
import {LifecycleControl} from "./LifecycleControl.tsx";
import {ProgressMeter, ShareMeter} from "./Meters.tsx";
import {ResultCard} from "./ResultCard.tsx";
import {StatusTimeline} from "./StatusTimeline.tsx";
import "./rounds.css";

const KIND_LABELS = [
  rounds.card.kinds.Day100,
  rounds.card.kinds.Day1k,
  rounds.card.kinds.Day10k,
  rounds.card.kinds.Week1k,
  rounds.card.kinds.Week10k,
  rounds.card.kinds.Week100k,
  rounds.card.kinds.Month100k,
] as const;

export type RoundDetailProps = {
  data: RoundData;
  price: PriceState;
  now: bigint;
  account: Address | null;
  position: Position | null;
  asset: ManifestAsset | null;
  /** Every range of the round, or null while they load or when the round is too large to page. */
  ranges: readonly Range[] | null;
  rangesError: string | null;
  /** The transaction this page's lifecycle control owns. */
  lifecycleTx: TransactionHandle;
  /** The entry panel, when the round is open and takes entries. */
  entryPanel?: ReactNode;
  chainId: bigint;
  explorerUrl: string | null;
  /** The Draw contract, so the Verify section links to the exact address that holds this round (§9.1 X8). */
  drawAddress: Address;
};

export function RoundDetail(props: RoundDetailProps) {
  const {data, price, now, account, position, asset, ranges, rangesError, chainId, explorerUrl} = props;
  const {round, pool} = data;
  const [sheetOpen, setSheetOpen] = useState(false);

  const decimals = round.tokenDecimals;
  const symbol = asset?.symbol ?? "";
  const lifecycle = lifecycleOf(round, now, {
    hasPosition: position !== null && position.gross > 0n,
    refunded: position?.refunded === true,
  });
  const progress = targetProgressOf(round, price.price);
  const timeline = useMemo(() => timelineOf(round), [round]);
  const holders = useMemo(
    () => (ranges === null ? null : aggregateHolders(ranges, round.seedAccount)),
    [ranges, round.seedAccount],
  );
  const ledger = useMemo(
    () => (ranges === null ? null : ledgerOf(ranges, round.seedAccount)),
    [ranges, round.seedAccount],
  );
  const potUsd = usdWhole(round, price.price, round.grossTotal);
  const prizeUsd = usdWhole(round, price.price, round.prizePot);
  const players = playersExcludingSeed(round);
  const lone = position !== null && position.gross > 0n && players === 1n;

  return (
    <>
      <div className="page-heading">
        <h1>{fill(rounds.round.title, {roundId: round.id.toString()})}</h1>
        <Link to="/">{rounds.round.backToPools}</Link>
      </div>

      <Card
        title={
          <span className="chip-row">
            {asset === null ? null : <AssetBadge asset={asset} />}
            <span>
              {fill(rounds.round.heading, {
                symbol,
                kind: KIND_LABELS[round.kind],
                sequence: round.sequence.toString(),
              })}
            </span>
          </span>
        }
        aside={<StateBadge tone="info" label={rounds.round.stateLabels[lifecycle.catalogKey]} />}
      >
        <div className="round-header">
          <p className="small muted">
            {rounds.round.targetLabel}:{" "}
            <span className="amount">
              {fill(rounds.round.targetValue, {target: usdWholeText(round.targetUsd)})}
            </span>
            {" · "}
            {rounds.round.cutoffLabel}: <span className="amount">{cutoffText(round.closesAt)}</span>
          </p>
          {round.state === State.Open ? (
            <Countdown remaining={remainingSeconds(round.closesAt, now)} announce />
          ) : null}
        </div>
        <ProgressMeter usd={progress.usd} target={progress.target} filledBps={progress.filledBps} />
        <StatusTimeline steps={timeline} />
      </Card>

      <Card title={rounds.round.potHeading}>
        <dl className="entry-disclosures">
          <dt>{rounds.round.potTotal}</dt>
          <dd className="amount">{credit(round.grossTotal, decimals, symbol)}</dd>
          <dt>{rounds.round.feeReserve}</dt>
          <dd className="amount">{credit(round.feeReserved, decimals, symbol)}</dd>
          <dt>{round.state === State.Settled ? rounds.round.prizeSettled : rounds.round.prizeNow}</dt>
          <dd className="amount">{credit(round.prizePot, decimals, symbol)}</dd>
        </dl>
        <p className="small muted">
          {rounds.round.prizeNote}{" "}
          {potUsd === null || prizeUsd === null
            ? rounds.card.potUsdUnavailable
            : `${fill(rounds.round.usdEstimate, {usd: usdWholeText(prizeUsd)})}`}
        </p>
        <p className="small">
          {round.seeded
            ? fill(rounds.round.seedLine, {amount: credit(round.seedGross, decimals, symbol)})
            : pool.seedAmount > 0n
              ? fill(rounds.round.seedPendingLine, {amount: credit(pool.seedAmount, decimals, symbol)})
              : rounds.round.unseededLine}
        </p>
        <p className="small">
          {players === 0n
            ? rounds.card.participantsNone
            : players === 1n
              ? rounds.card.participantsOne
              : fill(rounds.card.participants, {players: players.toString()})}
          {round.seeded ? ` ${rounds.card.seedSeparate}` : ""}
        </p>
        {lone ? (
          <p className="notice notice--info small">
            {round.seeded ? rounds.round.lonePlayerSeeded : rounds.round.lonePlayerUnseeded}
          </p>
        ) : null}
      </Card>

      <Card title={rounds.round.timelineLabel}>
        <LifecycleControl round={round} lifecycle={lifecycle} account={account} tx={props.lifecycleTx} />
        {/*
          The route out of a closed round, for every state that is not Open (SPEC §9.5: "If another purchase
          reaches the target first ... the app offers the new round"). It is shown alongside the lifecycle
          control rather than instead of it: AwaitingRequest, Ready and Refunding all offer an action, and
          they are exactly the states a player lands in after losing a target race, so hiding the link
          whenever there is an action is what left that path without an exit.
        */}
        {round.state !== State.Open && data.currentRoundId !== 0n && data.currentRoundId !== round.id ? (
          <p className="small">
            <Link to={`/round/${chainId}/${data.currentRoundId}`}>{rounds.round.successorLink}</Link>
          </p>
        ) : null}
      </Card>

      {props.entryPanel === undefined ? null : (
        <>
          <div className={sheetOpen ? "entry-sheet entry-sheet--open" : "entry-sheet"}>
            <Card>{props.entryPanel}</Card>
            {sheetOpen ? (
              <Button variant="ghost" onClick={() => setSheetOpen(false)}>
                {rounds.entry.closeSheet}
              </Button>
            ) : null}
          </div>
          {sheetOpen ? null : (
            <div className="entry-open-bar">
              <Button variant="primary" block onClick={() => setSheetOpen(true)}>
                {rounds.entry.openSheet}
              </Button>
            </div>
          )}
        </>
      )}

      {/*
        The SPEC §14 limitations and the operator's jurisdiction sentence, directly under the entry panel:
        this is the last thing between reading the round and paying for an entry, and it is rendered whether
        or not the round still takes entries, so a closed round discloses the same terms as an open one.
        It reads the manifest and the build environment itself; everything round-specific still arrives as a
        prop, so this file stays renderable from a fixture.
      */}
      <JurisdictionNotice />
      <Disclosures compact />

      <Card title={rounds.round.positionHeading}>
        {account === null ? (
          <p className="muted">{rounds.round.positionConnect}</p>
        ) : position === null || position.gross === 0n ? (
          <p className="muted">{rounds.round.positionNone}</p>
        ) : (
          <>
            <dl className="entry-disclosures">
              <dt>{rounds.round.positionGross}</dt>
              <dd className="amount">{credit(position.gross, decimals, symbol)}</dd>
              <dt>{rounds.round.positionShare}</dt>
              <dd className="amount">{formatShare(position.gross, round.grossTotal)}</dd>
              {position.refunded ? (
                <>
                  <dt>{rounds.round.positionRefunded}</dt>
                  <dd>{rounds.round.refundCredited}</dd>
                </>
              ) : null}
            </dl>
            <ShareMeter
              numerator={position.gross}
              denominator={round.grossTotal}
              label={rounds.round.positionShare}
              note={round.state === State.Open ? rounds.card.shareNote : null}
            />
          </>
        )}
      </Card>

      <ResultCard round={round} position={position} account={account} decimals={decimals} symbol={symbol} />

      <Card title={rounds.round.holdersHeading}>
        {rangesError !== null ? (
          <EmptyState title={rounds.holders.tooLarge} body={rangesError} />
        ) : holders === null ? (
          <p className="muted">{rounds.round.loading}</p>
        ) : (
          <HoldersTable
            holders={holders}
            grossTotal={round.grossTotal}
            decimals={decimals}
            symbol={symbol}
            account={account}
          />
        )}
      </Card>

      <Card title={rounds.round.ledgerHeading}>
        <p className="small muted">{rounds.round.ledgerNote}</p>
        {ledger === null ? (
          <p className="muted">{rounds.round.loading}</p>
        ) : (
          <EntryLedger ledger={ledger} decimals={decimals} symbol={symbol} account={account} />
        )}
      </Card>

      <Card title={rounds.round.feeOddsHeading}>
        <p>{rounds.round.feeOddsBody}</p>
        {pool.seedAmount > 0n ? <p className="small">{rounds.round.feeOddsSeed}</p> : null}
        <p className="small">
          <Link to="/verify">{rounds.round.verifyLink}</Link>
          {explorerUrl === null ? null : (
            <>
              {" · "}
              <a
                href={`${explorerUrl}/address/${props.drawAddress}`}
                rel="noreferrer noopener"
                target="_blank"
              >
                {rounds.round.explorerLink}
              </a>
            </>
          )}
        </p>
      </Card>
    </>
  );
}
