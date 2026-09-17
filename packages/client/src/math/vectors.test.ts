/// Differential test against `contracts/test/vectors/spec_vectors.json` (SPEC §11.2 "Math": "Solidity and
/// `packages/client/src/math` must reproduce every vector").
///
/// The vectors are produced by `scripts/spec_reference.py` and are the same file the Foundry suite loads with
/// `vm.readFile`, so a disagreement here is a disagreement between this client and the reference, not a
/// difference of fixtures. Every family in the file must be present and non-empty: a vectors file that lost a
/// family, or was written with zero rows, fails instead of passing vacuously.
///
/// Each family prints one `LDCLIENT_VECTORS | family=... | vectors=... | assertions=...` line, and the run
/// ends with a TOTAL line, for the ACCEPTANCE evidence ledger.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import test from "node:test";
import type {Address} from "../types/common.ts";
import type {Range} from "../types/generated.ts";
import {applyEntry, feeDelta, feeOf} from "./fee.ts";
import {KIND, type Kind} from "./localTypes.ts";
import {minGrossRaw, targetGross} from "./price.ts";
import {nextCutoff} from "./schedule.ts";
import {findWinner, winningIndex} from "./selection.ts";

// src/math -> src -> client -> packages -> repository root.
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const VECTORS_PATH = resolve(REPO_ROOT, "contracts", "test", "vectors", "spec_vectors.json");

interface MinimumVector {
  tokenDecimals: number;
  feedDecimals: number;
  price: string;
  minGrossRaw: string;
}

interface TargetGrossVector {
  tokenDecimals: number;
  feedDecimals: number;
  price: string;
  targetUsd: number;
  minGrossToReach: string;
}

interface FeeStep {
  gross: string;
  feeDelta: string;
  grossTotal: string;
  feeReserved: string;
}

interface IndexModularVector {
  word0: string;
  word1: string;
  weight: string;
  index: string;
}

interface CutoffVector {
  t: number;
  Day: number;
  Week: number;
  Month: number;
}

interface BinarySearchVector {
  ranges: {buyer: number; cumulativeGross: number}[];
  cases: {index: number; buyer: number}[];
}

interface SpecVectors {
  spec: string;
  seed: number;
  minimum: MinimumVector[];
  targetGross: TargetGrossVector[];
  feeSequences: FeeStep[][];
  indexModular: IndexModularVector[];
  cutoffs: CutoffVector[];
  binarySearch: BinarySearchVector[];
}

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as SpecVectors;

let totalVectors = 0;
let totalAssertions = 0;

/// One counted assertion. The count is the evidence number, so every comparison goes through here.
function eq<T>(actual: T, expected: T, message: string): void {
  totalAssertions += 1;
  familyAssertions += 1;
  assert.strictEqual(actual, expected, message);
}

let familyAssertions = 0;

/// Starts a family: fails loudly when it is missing or empty, and returns its rows.
function family<T>(name: string, rows: T[] | undefined): T[] {
  assert.ok(Array.isArray(rows), `vectors file has no "${name}" family`);
  assert.ok(rows.length > 0, `vectors family "${name}" is empty`);
  familyAssertions = 0;
  return rows;
}

function report(name: string, count: number): void {
  totalVectors += count;
  console.log(`LDCLIENT_VECTORS | family=${name} | vectors=${count} | assertions=${familyAssertions}`);
}

test("vectors file identifies the spec version and seed it was generated from", () => {
  assert.strictEqual(vectors.spec, "v8", `unexpected vectors spec version: ${vectors.spec}`);
  assert.strictEqual(vectors.seed, 20260911, `unexpected vectors seed: ${vectors.seed}`);
});

test("minimum: minGrossRaw reproduces every vector", () => {
  const rows = family("minimum", vectors.minimum);
  for (const row of rows) {
    const got = minGrossRaw(row.tokenDecimals, row.feedDecimals, BigInt(row.price));
    eq(
      got,
      BigInt(row.minGrossRaw),
      `minGrossRaw(d=${row.tokenDecimals}, f=${row.feedDecimals}, p=${row.price})`,
    );
  }
  report("minimum", rows.length);
});

test("targetGross: minGrossToReach reproduces every vector", () => {
  const rows = family("targetGross", vectors.targetGross);
  for (const row of rows) {
    const got = targetGross(row.tokenDecimals, row.feedDecimals, BigInt(row.price), BigInt(row.targetUsd));
    eq(
      got,
      BigInt(row.minGrossToReach),
      `targetGross(d=${row.tokenDecimals}, f=${row.feedDecimals}, p=${row.price}, target=${row.targetUsd})`,
    );
  }
  report("targetGross", rows.length);
});

test("feeSequences: cumulative fee state matches after every step", () => {
  const rows = family("feeSequences", vectors.feeSequences);
  let steps = 0;
  for (const [sequenceIndex, sequence] of rows.entries()) {
    assert.ok(sequence.length > 0, `fee sequence ${sequenceIndex} is empty`);
    let state = {grossTotal: 0n, feeReserved: 0n};
    for (const [stepIndex, step] of sequence.entries()) {
      steps += 1;
      const where = `sequence ${sequenceIndex} step ${stepIndex}`;
      const gross = BigInt(step.gross);
      const standalone = feeDelta(state.grossTotal, gross);
      const applied = applyEntry(state, gross);

      eq(applied.feeDelta, BigInt(step.feeDelta), `${where}: feeDelta`);
      eq(applied.grossTotal, BigInt(step.grossTotal), `${where}: grossTotal`);
      eq(applied.feeReserved, BigInt(step.feeReserved), `${where}: feeReserved`);
      eq(standalone, applied.feeDelta, `${where}: feeDelta helper agrees with applyEntry`);

      state = {grossTotal: applied.grossTotal, feeReserved: applied.feeReserved};
    }
    const last = sequence[sequence.length - 1];
    assert.ok(last !== undefined);
    eq(
      state.feeReserved,
      feeOf(BigInt(last.grossTotal)),
      `sequence ${sequenceIndex}: final reserve is F(total)`,
    );
  }
  report("feeSequences", rows.length);
  console.log(
    `LDCLIENT_VECTORS | family=feeSequences.steps | vectors=${steps} | assertions=${familyAssertions}`,
  );
});

test("indexModular: the 512-bit modular index reproduces every vector", () => {
  const rows = family("indexModular", vectors.indexModular);
  for (const row of rows) {
    const got = winningIndex(BigInt(row.word0), BigInt(row.word1), BigInt(row.weight));
    eq(got, BigInt(row.index), `winningIndex(w0=${row.word0}, w1=${row.word1}, W=${row.weight})`);
  }
  report("indexModular", rows.length);
});

test("cutoffs: all seven kinds reproduce every vector", () => {
  const rows = family("cutoffs", vectors.cutoffs);
  const kinds: [name: "Day" | "Week" | "Month", kind: Kind][] = [
    ["Day", KIND.Day100],
    ["Day", KIND.Day1k],
    ["Day", KIND.Day10k],
    ["Week", KIND.Week1k],
    ["Week", KIND.Week10k],
    ["Week", KIND.Week100k],
    ["Month", KIND.Month100k],
  ];
  for (const row of rows) {
    for (const [name, kind] of kinds) {
      eq(
        nextCutoff(BigInt(row.t), kind),
        BigInt(row[name]),
        `nextCutoff(${row.t}, ${name} cadence, kind ${kind})`,
      );
    }
  }
  report("cutoffs", rows.length);
});

test("binarySearch: every case of every range list selects the vector's buyer", () => {
  const rows = family("binarySearch", vectors.binarySearch);
  let cases = 0;
  for (const [listIndex, row] of rows.entries()) {
    assert.ok(row.ranges.length > 0, `binarySearch list ${listIndex} has no ranges`);
    assert.ok(row.cases.length > 0, `binarySearch list ${listIndex} has no cases`);
    // The reference numbers buyers 0-4; the client's `Range.buyer` is an address, so the ids are widened to
    // distinct addresses and narrowed back. The mapping is injective, so it proves exactly what the vector does.
    const ranges: Range[] = row.ranges.map((range) => ({
      buyer: buyerAddress(range.buyer),
      cumulativeGross: BigInt(range.cumulativeGross),
    }));
    for (const testCase of row.cases) {
      cases += 1;
      eq(
        findWinner(ranges, BigInt(testCase.index)),
        buyerAddress(testCase.buyer),
        `list ${listIndex}: findWinner(index=${testCase.index})`,
      );
    }
  }
  report("binarySearch", rows.length);
  console.log(
    `LDCLIENT_VECTORS | family=binarySearch.cases | vectors=${cases} | assertions=${familyAssertions}`,
  );
});

test("total", () => {
  console.log(`LDCLIENT_VECTORS | family=TOTAL | vectors=${totalVectors} | assertions=${totalAssertions}`);
  assert.ok(totalAssertions > 0, "no vector assertions ran");
});

/// Widens a reference buyer id (0-4) to a distinct lowercase address.
function buyerAddress(id: number): Address {
  return `0x${id.toString(16).padStart(40, "0")}`;
}
