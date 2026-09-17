// The freshness line every read surface shows (SPEC §10.1: "return chainId, blockNumber, blockHash,
// timestamp and confidence with the snapshot. Provisional values are visually distinct from confirmed ones").
//
// The age is computed from the snapshot's chain timestamp and the app's single 1 Hz monotonic ticker, never
// from a wall clock difference that a wrong device clock could distort (§9.6).

import type {Confidence, Snapshot} from "@luckydraw/client";
import {formatCountdown} from "@luckydraw/client";
import {useSecondsTick} from "../lib/data/BlockProvider.tsx";
import {en, fill} from "../strings/en.ts";
import {StateBadge, type StateTone} from "./StateBadge.tsx";

/** The label and tone for a snapshot's confidence tag. `latest` is provisional and says so. */
export function describeConfidence(confidence: Confidence): {label: string; tone: StateTone} {
  switch (confidence.tag) {
    case "finalized":
      return {label: en.data.confidenceFinalized, tone: "positive"};
    case "safe":
      return {label: en.data.confidenceSafe, tone: "info"};
    default:
      return {
        label:
          confidence.depth === null || confidence.depth === 0n
            ? en.data.confidenceLatest
            : fill(en.data.confidenceLatestDepth, {depth: confidence.depth.toString()}),
        tone: "pending",
      };
  }
}

export type DataFreshnessProps = {
  snapshot: Snapshot<unknown> | null;
  /** Wall-clock seconds now, for the age. Defaults to the device clock, which only affects a label. */
  nowSeconds?: bigint;
};

export function DataFreshness({snapshot, nowSeconds}: DataFreshnessProps) {
  // Subscribing to the shared ticker is what re-renders the age once a second.
  useSecondsTick();
  if (snapshot === null) {
    return <span className="freshness">{en.data.unavailable}</span>;
  }
  const now = nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const elapsed = now > snapshot.timestamp ? now - snapshot.timestamp : 0n;
  const confidence = describeConfidence(snapshot.confidence);
  return (
    <span className="freshness">
      <span className="visually-hidden">{en.data.freshnessLabel}</span>
      <span className="amount">{fill(en.data.block, {block: snapshot.blockNumber.toString()})}</span>
      <span>{elapsed === 0n ? en.data.ageNow : fill(en.data.age, {age: formatCountdown(elapsed)})}</span>
      <StateBadge tone={confidence.tone} label={confidence.label} />
    </span>
  );
}
