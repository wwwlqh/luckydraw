// The Open -> Closed -> Randomness requested -> Result timeline of SPEC §9.4.
//
// An ordered list, not a decoration: each step carries its own state as a word ("done", "current", "not
// yet"), so the progress is readable without colour and without the glyph (§9.3, §9.7). Nothing here
// animates and nothing here runs ahead of the chain: a step is "done" only once the round's state says so
// (§9.1 X2, "Never fake certainty").

import type {TimelineStep} from "../../lib/rounds/derive.ts";
import {rounds} from "../../strings/rounds.ts";
import "./rounds.css";

const STEP_LABELS: Readonly<Record<TimelineStep["name"], string>> = {
  open: rounds.round.timelineOpen,
  closed: rounds.round.timelineClosed,
  requested: rounds.round.timelineRequested,
  result: rounds.round.timelineResult,
};

const STATUS_LABELS: Readonly<Record<TimelineStep["status"], string>> = {
  done: rounds.round.timelineDone,
  current: rounds.round.timelineCurrent,
  waiting: rounds.round.timelineWaiting,
};

const GLYPHS: Readonly<Record<TimelineStep["status"], string>> = {done: "✓", current: "◷", waiting: "·"};

export function StatusTimeline({steps}: {steps: readonly TimelineStep[]}) {
  return (
    <ol className="timeline" aria-label={rounds.round.timelineLabel}>
      {steps.map((step) => (
        <li key={step.name} className={`timeline__step timeline__step--${step.status}`}>
          <span aria-hidden="true">{GLYPHS[step.status]}</span>
          <span>{STEP_LABELS[step.name]}</span>
          <span className="visually-hidden">{STATUS_LABELS[step.status]}</span>
        </li>
      ))}
    </ol>
  );
}
