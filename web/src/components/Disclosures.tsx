// The limitations the app is required to state (SPEC §14 last paragraph, §7.3), and the operator's
// jurisdiction sentence (SPEC §14).
//
// §14: "The app must state the same limitations as the contracts." Six of them, all of which are properties
// of the deployed system rather than of a particular round, so one component carries them and both the help
// page and every round page render it. Keeping them in one place is the point: a limitation that is worded
// one way on help and another way next to the entry panel is a limitation someone will argue about later.
//
// Two things are read rather than written: the make-whole reserve and cap come from the deployment manifest
// this build was compiled against, so the figures on the page are the operator's own recorded numbers and
// never a claim this file makes; and the jurisdiction sentence comes from the build environment, as plain
// text placed in a text node. Nothing here ever renders markup from either source.
//
// `JurisdictionNotice` is deliberately *not* part of `Disclosures`. Each page places it once, where it
// belongs on that page — at the top of help and verify, beside the entry panel on a round — so no page ever
// prints the operator's sentence twice.
//
// Accessibility: each block is a `<section>` with a real heading, the serious framing is the visible word
// "Important" rather than the border colour, and the list is an ordinary `<ul>`, so a screen reader reads
// the same content in the same order as the page shows it (SPEC §9.3, §9.7).

import {useDeployment} from "../lib/deployment/DeploymentProvider.tsx";
import {credit} from "../lib/rounds/format.ts";
import {en, fill} from "../strings/en.ts";
import {Card} from "./Card.tsx";

/**
 * The operator's jurisdiction sentence, or nothing when this build has none. A chain 56 build cannot have
 * none: `lib/build/releaseGate.ts` refuses it and `lib/config/env.ts` refuses to parse it.
 */
export function JurisdictionNotice() {
  const {env} = useDeployment();
  const notice = env.jurisdictionNotice.trim();
  if (notice === "") return null;
  return (
    <p className="notice notice--info small" role="note" aria-label={en.jurisdiction.label}>
      <strong>{en.jurisdiction.heading}</strong>
      {/* A text node. The sentence is the operator's own words and is never interpreted as markup. */}
      <span>{notice}</span>
    </p>
  );
}

export type DisclosuresProps = {
  /** Set on the round page, where the block sits under the entry panel rather than among help articles. */
  compact?: boolean;
};

/**
 * The §14 limitations, the §7.3 make-whole commitment with this deployment's recorded reserve and cap, and
 * the jurisdiction sentence.
 */
export function Disclosures({compact = false}: DisclosuresProps) {
  const {manifest, chain} = useDeployment();
  const {makeWholeReserve, makeWholeCap} = manifest.ownership;
  const limits = en.limits;

  // Recorded as uint256 strings in the manifest's `ownership` block and held by the treasury Safe, so they
  // are shown in the chain's native currency, rounded down: a reserve must never read as larger than it is.
  const amounts =
    makeWholeReserve === null || makeWholeCap === null
      ? limits.makeWholeUnfunded
      : fill(limits.makeWholeAmounts, {
          reserve: credit(makeWholeReserve, 18, chain.nativeSymbol),
          cap: credit(makeWholeCap, 18, chain.nativeSymbol),
        });

  return (
    <Card title={limits.heading}>
      <p className={compact ? "small" : "muted"}>
        <strong>{limits.noticeLabel}</strong> {limits.intro}
      </p>
      <ul className="disclosures">
        <li>{limits.entryFee}</li>
        <li>{limits.uncapped}</li>
        <li>{limits.noCashOut}</li>
        <li>{limits.seedIsAnEntry}</li>
        <li>{limits.pause}</li>
        <li>
          {limits.drawing} {limits.makeWhole} {amounts}
        </li>
      </ul>
    </Card>
  );
}
