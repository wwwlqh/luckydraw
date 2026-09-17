// The countdown to a cutoff (SPEC §9.3 components, §9.6, §9.7).
//
// Two rules it exists to keep:
//
//  - the remaining seconds come from the caller, who derived them from a chain timestamp and the app's
//    monotonic ticker (`useChainNow`). This component never reads a clock of its own (§9.6);
//  - it announces only at the thresholds of §9.7 — one hour, ten minutes, one minute, closed — never once a
//    second. The live region is always in the DOM and only its text changes, so an announcement is not lost
//    to a region that was inserted at the same moment.

import {formatCountdown} from "@luckydraw/client";
import {useEffect, useRef, useState} from "react";
import {announceOn, type CountdownBucket} from "../../lib/rounds/derive.ts";
import {rounds} from "../../strings/rounds.ts";
import "./rounds.css";

const ANNOUNCEMENTS: Readonly<Record<Exclude<CountdownBucket, null>, string>> = {
  hour: rounds.round.announceHour,
  tenMinutes: rounds.round.announceTenMinutes,
  minute: rounds.round.announceMinute,
  closed: rounds.round.announceClosed,
};

export type CountdownProps = {
  /** Seconds remaining, already floored at zero by the caller. */
  remaining: bigint;
  /** Accessible name of the figure. Defaults to the round page's "time until the cutoff". */
  label?: string;
  /** False on a card in a list: one live region per page is enough. */
  announce?: boolean;
};

export function Countdown({
  remaining,
  label = rounds.round.countdownLabel,
  announce = false,
}: CountdownProps) {
  const previous = useRef<bigint | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (!announce) return;
    const bucket = announceOn(previous.current, remaining);
    previous.current = remaining;
    if (bucket !== null) setAnnouncement(ANNOUNCEMENTS[bucket]);
  }, [remaining, announce]);

  return (
    <span className="countdown">
      <span className="visually-hidden">{label}</span>
      <span className="amount">{formatCountdown(remaining)}</span>
      {announce ? (
        <span className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </span>
      ) : null}
    </span>
  );
}
