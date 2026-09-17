// Confirming a discovered round against the chain, and sorting one account's positions into the five tabs
// of SPEC §9.4 (`/entries`).
//
// Two rules govern everything here:
//
//   1. a log is a claim, the contract is the answer. Every candidate round id from `discovery.ts` is read
//      back with `getPosition` and `getRound` at ONE snapshot block (SPEC §10.1: "Related direct reads use
//      one blockTag"), and a candidate whose position is zero gross is dropped, whatever its log said;
//   2. "Never mark unsettled positions lost" (SPEC §9.4). A position is only ever `lost` when its round is
//      Settled and the winner is somebody else. Every other outcome is a state, not a verdict, and the
//      `outcome` field below has no value that a page could render as a loss before Settled.

import {
  type Address,
  type Position,
  type ReadContext,
  type RoundView,
  readPosition,
  readRound,
  type Snapshot,
  State,
  type StateName,
  snapshotOf,
  stateName,
} from "@luckydraw/client";
import {blockFor} from "./tokenReads.ts";

/** The five tabs of SPEC §9.4, in their navigation order. */
export const ENTRY_TABS = ["active", "awaiting", "won", "refunds", "past"] as const;
export type EntryTab = (typeof ENTRY_TABS)[number];

/**
 * What happened to this account in this round, as a fact rather than a mood.
 *
 * `pending` is every state before a result exists; there is deliberately no "lost" until Settled names
 * another winner, and no "won" until Settled names this account (SPEC §9.4, §9.1 X2).
 */
export type PositionOutcome = "pending" | "won" | "notSelected" | "refundClaimable" | "refunded" | "void";

export type PositionRow = {
  roundId: bigint;
  round: RoundView;
  position: Position;
  /** The round's state as a name, so the client's `stateCatalog` can be addressed by it. */
  state: StateName;
  outcome: PositionOutcome;
  /** Every tab this row belongs in. `past` overlaps `won` and a credited refund on purpose: it is history. */
  tabs: readonly EntryTab[];
  /** True while the round can still take entries, which is when the share is still moving (SPEC §9.5). */
  shareStillMoving: boolean;
  /** Gross still held in this round's escrow on this account's behalf; zero once it is credited or lost. */
  committed: bigint;
};

/**
 * The outcome for one account in one round.
 *
 * The `Refunding` split is `position.refunded`, the contract's own flag: an account that has been credited
 * has nothing left to claim and `claimRefund` would revert `AlreadyClaimed` (SPEC §6.2).
 */
export function outcomeOf(round: RoundView, position: Position, account: Address): PositionOutcome {
  switch (round.state) {
    case State.Settled:
      return round.winner === account ? "won" : "notSelected";
    case State.Refunding:
      return position.refunded ? "refunded" : "refundClaimable";
    case State.Void:
      // A Void round had no player entry at all, so a player position in one can only be a seed return.
      return "void";
    default:
      return "pending";
  }
}

/**
 * Which tabs a row belongs in.
 *
 * | Round state                     | Tabs                |
 * |---------------------------------|---------------------|
 * | Open                            | active              |
 * | AwaitingRequest, Drawing, Ready | awaiting            |
 * | Settled, this account won       | won, past           |
 * | Settled, another account won    | past                |
 * | Refunding, not yet credited     | refunds             |
 * | Refunding, credited             | refunds, past       |
 * | Void                            | past                |
 *
 * `past` is the history tab: a round that has concluded for this account appears there as well as in the tab
 * that says what it concluded as. A round still waiting for a result never appears in `past`, so nothing
 * unsettled can read as finished.
 */
export function tabsOf(outcome: PositionOutcome, round: RoundView): readonly EntryTab[] {
  switch (outcome) {
    case "won":
      return ["won", "past"];
    case "notSelected":
      return ["past"];
    case "refundClaimable":
      return ["refunds"];
    case "refunded":
      return ["refunds", "past"];
    case "void":
      return ["past"];
    default:
      return round.state === State.Open ? ["active"] : ["awaiting"];
  }
}

/** Escrow still standing behind this account in this round. */
function committedOf(outcome: PositionOutcome, position: Position): bigint {
  return outcome === "pending" || outcome === "refundClaimable" ? position.gross : 0n;
}

export function rowOf(round: RoundView, position: Position, account: Address): PositionRow {
  const outcome = outcomeOf(round, position, account);
  return {
    roundId: round.id,
    round,
    position,
    state: stateName(round.state),
    outcome,
    tabs: tabsOf(outcome, round),
    shareStillMoving: round.state === State.Open,
    committed: committedOf(outcome, position),
  };
}

/**
 * Reads every candidate round back from the chain at one block and keeps the ones this account really holds.
 *
 * A candidate whose `getPosition` reports zero gross is dropped silently: that is what a log from a
 * look-alike emitter, a reorged-away entry or a stale cache looks like from here, and none of them is an
 * error worth showing.
 */
export async function resolvePositions(
  ctx: ReadContext,
  roundIds: readonly bigint[],
  account: Address,
): Promise<Snapshot<readonly PositionRow[]>> {
  const block = await blockFor(ctx);
  const pinned: ReadContext = {...ctx, block};
  const rows: PositionRow[] = [];
  for (const roundId of roundIds) {
    const [position, round] = await Promise.all([
      readPosition(pinned, roundId, account),
      readRound(pinned, roundId),
    ]);
    if (position.value.gross <= 0n) continue;
    rows.push(rowOf(round.value, position.value, account));
  }
  rows.sort((left, right) => (left.roundId > right.roundId ? -1 : left.roundId < right.roundId ? 1 : 0));
  return snapshotOf(ctx.deployment, block, rows);
}

/** Total gross still committed per asset, for the Wallet page's "Committed to rounds" column (§9.4). */
export function committedByAsset(rows: readonly PositionRow[]): ReadonlyMap<Address, bigint> {
  const totals = new Map<Address, bigint>();
  for (const row of rows) {
    if (row.committed <= 0n) continue;
    totals.set(row.round.asset, (totals.get(row.round.asset) ?? 0n) + row.committed);
  }
  return totals;
}
