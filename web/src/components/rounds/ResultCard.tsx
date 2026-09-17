// The result, refund and void outcomes of a round (SPEC §9.6 state table, §9.4, §7.2).
//
// Settled shows the winner, the prize and the 3% earned fee, and a buyer who was not drawn sees "Not
// selected" with their share and a Verify link — never "lost" and never a settled-looking result before the
// chain produced one (§9.1 X2, §9.6). Refunding says the refund is credited once this account's position
// says `refunded`, and Void states that no player funds were committed and, when the round was seeded, that
// the seed went back in the closing transaction (§5.4).
//
// The winning calculation is shown in full, from stored values only: the two verified words, the winning
// index and the gross they were reduced across (§7.2). Nothing here recomputes a winner.

import {type Address, type Position, type RoundView, State} from "@luckydraw/client";
import {Link} from "react-router";
import {credit, formatShare} from "../../lib/rounds/format.ts";
import {fill} from "../../strings/en.ts";
import {rounds} from "../../strings/rounds.ts";
import {Card, StateBadge, truncateAddress} from "../index.ts";
import "./rounds.css";

export type ResultCardProps = {
  round: RoundView;
  position: Position | null;
  account: Address | null;
  decimals: bigint;
  symbol: string;
};

export function ResultCard({round, position, account, decimals, symbol}: ResultCardProps) {
  if (round.state === State.Settled) {
    const won = account !== null && round.winner === account;
    return (
      <Card
        title={rounds.round.settleHeading}
        aside={
          won ? (
            <StateBadge tone="positive" label={rounds.round.resultWinner} />
          ) : (
            <StateBadge tone="neutral" label={rounds.round.resultOther} />
          )
        }
      >
        {won ? (
          <p>{fill(rounds.round.resultWinnerPrize, {prize: credit(round.prizePot, decimals, symbol)})}</p>
        ) : position !== null && position.gross > 0n ? (
          <p>
            {fill(rounds.round.resultOtherBody, {
              share: formatShare(position.gross, round.grossTotal),
            })}
          </p>
        ) : null}
        <dl className="definition-list">
          <dt>{rounds.round.resultWinnerAddress}</dt>
          <dd className="mono">{truncateAddress(round.winner)}</dd>
          <dt>{rounds.round.prizeSettled}</dt>
          <dd className="amount">{credit(round.prizePot, decimals, symbol)}</dd>
          <dt>{rounds.round.resultFee}</dt>
          <dd className="amount">{credit(round.feeReserved, decimals, symbol)}</dd>
          <dt>{rounds.round.settleWords}</dt>
          <dd className="mono smallest">
            {round.word0.toString()} / {round.word1.toString()}
          </dd>
          <dt>{rounds.round.settleIndex}</dt>
          <dd className="amount">{round.winningIndex.toString()}</dd>
        </dl>
        <p className="small muted">
          {fill(rounds.round.settleFormula, {gross: credit(round.grossTotal, decimals, symbol)})}
        </p>
        <p className="small">
          <Link to="/verify">{rounds.round.verifyLink}</Link>
        </p>
      </Card>
    );
  }

  if (round.state === State.Refunding) {
    const refunded = position?.refunded === true;
    const hasEntry = position !== null && position.gross > 0n;
    return (
      <Card
        title={rounds.round.refundHeading}
        aside={refunded ? <StateBadge tone="positive" label={rounds.round.refundCredited} /> : undefined}
      >
        {!hasEntry ? (
          <p className="muted">{rounds.round.refundNoPosition}</p>
        ) : refunded ? (
          <p>{rounds.round.refundCredited}</p>
        ) : (
          <>
            <p>{rounds.round.refundPending}</p>
            <p className="amount">{credit(position.gross, decimals, symbol)}</p>
          </>
        )}
      </Card>
    );
  }

  if (round.state === State.Void && round.seeded) {
    return (
      <Card title={rounds.round.timelineResult}>
        <p>{rounds.round.voidSeedReturned}</p>
      </Card>
    );
  }

  return null;
}
