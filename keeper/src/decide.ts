// The SPEC §6.2 state table as one pure function.
//
// Nothing here reads a chain, signs, or knows what a provider is: it takes one round as the snapshot block
// saw it plus the four seed facts, and returns the single action to attempt for that round this cycle. That
// is what makes the table testable row by row, and it is why the loop in `keeper.ts` contains no `if
// (state === ...)` of its own.
//
// Order within a round is the brief's: seed, close, request, expire, settle, refund. Two refinements the
// table itself forces:
//
//   * a seed is attempted only while the round is Open *before* its cutoff. SPEC §5.4: a seed "succeeds when
//     the round is Open before cutoff"; `seedRound` past the cutoff reverts `EntryWindowClosed`. Without the
//     guard an unseeded round past its cutoff would spend its one action per cycle on a seed that can never
//     be mined and would never be closed.
//   * `Drawing` has no keeper action at all. SPEC §6.2 gives the transition to the coordinator's
//     authenticated callback, and §7.3 forbids re-requesting an accepted request.

import {type RoundView, State} from "./client.ts";

export type ActionKind =
  | "seedRound"
  | "closeRound"
  | "requestDraw"
  | "expireUnrequested"
  | "settle"
  | "claimRefunds";

/** Either the one action to attempt for this round, or the reason there is none. */
export type Decision =
  | {kind: ActionKind}
  | {kind: "none"; reason: string}
  /** Terminal, or fully refunded: the loop stops tracking the round. */
  | {kind: "done"; reason: string};

/** What the seed needs before `seedRound` is worth simulating (SPEC §5.4). */
export type SeedFacts = {
  /** The Draw points at a seed account and this pool's `seedAmount` is nonzero. */
  configured: boolean;
  /** `Vault.seedMaxPerRound(seedAccount, asset) >= seedAmount`: the account's own per-asset consent. */
  authorized: boolean;
  /** The seed account's available balance covers `seedAmount`. */
  funded: boolean;
};

export type RoundFacts = {
  round: RoundView;
  /** The snapshot block's timestamp; SPEC §10.2 reads chain time, never the host clock. */
  now: bigint;
  seed: SeedFacts;
};

/** The §6.2 row that applies to this round right now. */
export function decide(facts: RoundFacts): Decision {
  const {round, now, seed} = facts;
  switch (round.state) {
    case State.Open: {
      if (!round.seeded && now < round.closesAt) {
        if (!seed.configured) return {kind: "none", reason: "SeedNotConfigured"};
        if (!seed.authorized) return {kind: "none", reason: "SeedNotAuthorized"};
        if (!seed.funded) return {kind: "none", reason: "InsufficientSeedBalance"};
        return {kind: "seedRound"};
      }
      if (now >= round.closesAt) return {kind: "closeRound"};
      return {kind: "none", reason: "OpenBeforeCutoff"};
    }
    case State.AwaitingRequest:
      return now < round.requestDeadline ? {kind: "requestDraw"} : {kind: "expireUnrequested"};
    case State.Drawing:
      return {kind: "none", reason: "AwaitingCoordinatorCallback"};
    case State.Ready:
      return {kind: "settle"};
    case State.Refunding:
      return round.refundedGross >= round.grossTotal
        ? {kind: "done", reason: "FullyRefunded"}
        : {kind: "claimRefunds"};
    case State.Settled:
      return {kind: "done", reason: "Settled"};
    case State.Void:
      return {kind: "done", reason: "Void"};
    default:
      return {kind: "none", reason: `UnknownState:${String(round.state)}`};
  }
}
