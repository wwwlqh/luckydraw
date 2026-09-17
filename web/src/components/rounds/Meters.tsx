// The two meters of SPEC §9.3/§9.4: a round's progress toward its USD target, and one account's share.
//
// Both render a real `progressbar` with its value, minimum and maximum, so a screen reader reads a number
// rather than a decoration, and both pair the bar with a text caption: colour is never the only signal
// (§9.3). The fill width is a percentage computed from bigint basis points and applied through React's
// `style` prop, which goes through CSSOM — never `setAttribute("style")`, which the CSP forbids (§9.6).

import {formatShare} from "@luckydraw/client";
import {usdWholeText} from "../../lib/rounds/format.ts";
import {fill} from "../../strings/en.ts";
import {rounds} from "../../strings/rounds.ts";
import "./rounds.css";

/** Basis points to a CSS percentage string, exactly: 1234 -> "12.34%". */
function widthOf(bps: bigint): string {
  const clamped = bps < 0n ? 0n : bps > 10_000n ? 10_000n : bps;
  const whole = clamped / 100n;
  const rest = (clamped % 100n).toString().padStart(2, "0");
  return `${whole}.${rest}%`;
}

export type ProgressMeterProps = {
  /** Reference value of the pot in whole USD, or null when the price reference is unusable. */
  usd: bigint | null;
  target: bigint;
  /** 0-10000, or null when `usd` is null. */
  filledBps: bigint | null;
};

/** The pot's reference value toward the round's whole-USD target (SPEC §9.4). */
export function ProgressMeter({usd, target, filledBps}: ProgressMeterProps) {
  const label = fill(rounds.card.progressLabel, {target: usdWholeText(target)});
  if (usd === null || filledBps === null) {
    return (
      <div>
        <div
          className="meter"
          role="progressbar"
          aria-label={label}
          aria-valuetext={rounds.card.progressUnknown}
        />
        <p className="meter__caption">{rounds.card.progressUnknown}</p>
      </div>
    );
  }
  const caption = fill(rounds.card.progressValue, {usd: usdWholeText(usd), target: usdWholeText(target)});
  return (
    <div>
      <div
        className="meter"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number(filledBps / 100n)}
        aria-valuetext={caption}
      >
        <span className="meter__fill" style={{width: widthOf(filledBps)}} />
      </div>
      <p className="meter__caption">
        <span>{caption}</span>
      </p>
    </div>
  );
}

export type ShareMeterProps = {
  numerator: bigint;
  denominator: bigint;
  label: string;
  /** The §9.5 sentence under every share figure. Omitted on a settled round, where the share is final. */
  note?: string | null;
};

/** One account's share of a round's gross, which is its chance of winning (SPEC §9.5, §9.8). */
export function ShareMeter({numerator, denominator, label, note = rounds.card.shareNote}: ShareMeterProps) {
  const text = formatShare(numerator, denominator);
  const bps = denominator === 0n ? 0n : (numerator * 10_000n) / denominator;
  return (
    <div>
      <div
        className="meter"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Number(bps / 100n)}
        aria-valuetext={text}
      >
        <span className="meter__fill meter__fill--share" style={{width: widthOf(bps)}} />
      </div>
      <p className="meter__caption">
        <span>
          {label}: <span className="amount">{text}</span>
        </span>
        {note === null ? null : <span>{note}</span>}
      </p>
    </div>
  );
}
