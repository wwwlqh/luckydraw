// The SPEC §6.2 table, row by row. One case per branch, driven off the client's own `roundFixture` so the
// round shapes here cannot drift from the generated `RoundView`.

import assert from "node:assert/strict";
import test from "node:test";
import {roundFixture} from "../../packages/client/src/reads/testing/views.ts";
import {type RoundView, State} from "./client.ts";
import {type Decision, decide, type RoundFacts, type SeedFacts} from "./decide.ts";

const SEED_READY: SeedFacts = {configured: true, authorized: true, funded: true};
const SEED_NONE: SeedFacts = {configured: false, authorized: false, funded: false};

const CLOSES_AT = 1_790_035_200n;
const BEFORE = CLOSES_AT - 1n;
const DEADLINE = CLOSES_AT + 86_400n;

function facts(round: Partial<RoundView>, now: bigint, seed: SeedFacts = SEED_READY): RoundFacts {
  return {round: roundFixture({closesAt: CLOSES_AT, ...round}), now, seed};
}

const rows: readonly {name: string; facts: RoundFacts; expected: Decision}[] = [
  {
    name: "Open, unseeded, before cutoff, seed configured/authorized/funded -> seedRound",
    facts: facts({state: State.Open, seeded: false}, BEFORE),
    expected: {kind: "seedRound"},
  },
  {
    name: "Open, unseeded, seed not configured -> quiet skip",
    facts: facts({state: State.Open, seeded: false}, BEFORE, SEED_NONE),
    expected: {kind: "none", reason: "SeedNotConfigured"},
  },
  {
    name: "Open, unseeded, seed configured but the account has not authorized this asset -> skip",
    facts: facts({state: State.Open, seeded: false}, BEFORE, {
      configured: true,
      authorized: false,
      funded: false,
    }),
    expected: {kind: "none", reason: "SeedNotAuthorized"},
  },
  {
    name: "Open, unseeded, authorized but unfunded -> skip",
    facts: facts({state: State.Open, seeded: false}, BEFORE, {
      configured: true,
      authorized: true,
      funded: false,
    }),
    expected: {kind: "none", reason: "InsufficientSeedBalance"},
  },
  {
    name: "Open, seeded, before cutoff -> nothing to do",
    facts: facts({state: State.Open, seeded: true}, BEFORE),
    expected: {kind: "none", reason: "OpenBeforeCutoff"},
  },
  {
    name: "Open, seeded, at the cutoff -> closeRound",
    facts: facts({state: State.Open, seeded: true}, CLOSES_AT),
    expected: {kind: "closeRound"},
  },
  {
    name: "Open, unseeded, past the cutoff -> closeRound, never a seed that would revert EntryWindowClosed",
    facts: facts({state: State.Open, seeded: false}, CLOSES_AT + 5n),
    expected: {kind: "closeRound"},
  },
  {
    name: "AwaitingRequest before the request deadline -> requestDraw",
    facts: facts({state: State.AwaitingRequest, requestDeadline: DEADLINE}, DEADLINE - 1n),
    expected: {kind: "requestDraw"},
  },
  {
    name: "AwaitingRequest at the request deadline -> expireUnrequested (request is forbidden at it)",
    facts: facts({state: State.AwaitingRequest, requestDeadline: DEADLINE}, DEADLINE),
    expected: {kind: "expireUnrequested"},
  },
  {
    name: "AwaitingRequest past the request deadline -> expireUnrequested",
    facts: facts({state: State.AwaitingRequest, requestDeadline: DEADLINE}, DEADLINE + 3600n),
    expected: {kind: "expireUnrequested"},
  },
  {
    name: "Drawing -> the coordinator's callback owns the transition, the keeper waits",
    facts: facts({state: State.Drawing}, DEADLINE),
    expected: {kind: "none", reason: "AwaitingCoordinatorCallback"},
  },
  {
    name: "Ready -> settle",
    facts: facts({state: State.Ready}, DEADLINE),
    expected: {kind: "settle"},
  },
  {
    name: "Refunding with gross still unrefunded -> claimRefunds",
    facts: facts({state: State.Refunding, grossTotal: 100n, refundedGross: 40n}, DEADLINE),
    expected: {kind: "claimRefunds"},
  },
  {
    name: "Refunding, fully refunded -> stop tracking",
    facts: facts({state: State.Refunding, grossTotal: 100n, refundedGross: 100n}, DEADLINE),
    expected: {kind: "done", reason: "FullyRefunded"},
  },
  {
    name: "Settled -> stop tracking",
    facts: facts({state: State.Settled}, DEADLINE),
    expected: {kind: "done", reason: "Settled"},
  },
  {
    name: "Void -> stop tracking",
    facts: facts({state: State.Void}, DEADLINE),
    expected: {kind: "done", reason: "Void"},
  },
];

test("the SPEC 6.2 decision table", async (t) => {
  for (const row of rows) {
    await t.test(row.name, () => {
      assert.deepStrictEqual(decide(row.facts), row.expected);
    });
  }
});

test("every State value is covered by the table", () => {
  const covered = new Set(rows.map((row) => row.facts.round.state));
  for (const state of Object.values(State)) {
    assert.ok(covered.has(state), `State ${state} has no row`);
  }
});
