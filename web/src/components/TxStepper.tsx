// The TxStepper of SPEC §9.6: "Confirm in wallet -> Submitted -> Included -> Confirmed, each step with a
// timestamp and explorer link; failures show the decoded custom error in plain words with a next step."
//
// Two things it refuses to do: show anything as confirmed before the machine says `confirmed` (§9.1 X2,
// "Never fake certainty"), and show a failure without its funds effect and next action (§9.1 X4).

import {explorerTxUrl} from "../lib/deployment/provider.ts";
import type {ChainRecord} from "../lib/deployment/records.ts";
import {TX_STEP_ORDER, type TxState, type TxStepName} from "../lib/tx/types.ts";
import {en, fill} from "../strings/en.ts";
import {StateBadge} from "./StateBadge.tsx";

const STEP_LABELS: Readonly<Record<TxStepName, string>> = {
  preview: en.tx.stepPreview,
  walletConfirmation: en.tx.stepWalletConfirmation,
  submitted: en.tx.stepSubmitted,
  included: en.tx.stepIncluded,
  confirmed: en.tx.stepConfirmed,
};

const PHASE_MESSAGES: Readonly<Record<TxState["phase"], string>> = {
  idle: en.tx.stateIdle,
  preview: en.tx.statePreview,
  walletConfirmation: en.tx.stateWalletConfirmation,
  submitted: en.tx.stateSubmitted,
  included: en.tx.stateIncluded,
  confirmed: en.tx.stateConfirmed,
  rejected: en.tx.stateRejected,
  reverted: en.tx.stateReverted,
  replaced: en.tx.stateReplaced,
  dropped: en.tx.stateDropped,
  walletUnreachable: en.tx.stateWalletUnreachable,
};

const FAILED_PHASES: ReadonlySet<TxState["phase"]> = new Set([
  "rejected",
  "reverted",
  "replaced",
  "dropped",
  "walletUnreachable",
]);

/** True for the phases that mean the run is over, either way. */
export function isTerminal(phase: TxState["phase"]): boolean {
  return phase === "confirmed" || FAILED_PHASES.has(phase);
}

/** The one-sentence status for a phase. Shared by the stepper, the toast and the live region. */
export function phaseMessage(state: TxState): string {
  return state.failure?.message ?? PHASE_MESSAGES[state.phase];
}

const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export type TxStepperProps = {
  state: TxState;
  chain: ChainRecord;
};

export function TxStepper({state, chain}: TxStepperProps) {
  if (state.phase === "idle") return null;
  const reached = new Map(state.steps.map((entry) => [entry.name, entry] as const));
  const failedHere = FAILED_PHASES.has(state.phase);
  const explorer = state.hash === null ? null : explorerTxUrl(chain, state.hash);
  let markedFailure = false;

  return (
    <div className="stack">
      <ol className="stepper" aria-label={en.tx.stepperLabel}>
        {TX_STEP_ORDER.map((name) => {
          const entry = reached.get(name);
          let status: "done" | "current" | "failed" | "waiting";
          if (entry !== undefined) {
            status = name === state.phase ? "current" : "done";
          } else if (failedHere && !markedFailure) {
            status = "failed";
            markedFailure = true;
          } else {
            status = "waiting";
          }
          return (
            <li
              key={name}
              className={`stepper__item stepper__item--${status === "failed" ? "current" : status}`}
            >
              <StateBadge
                tone={status === "failed" ? "negative" : status === "waiting" ? "neutral" : "positive"}
                label={STEP_LABELS[name]}
              />
              {entry === undefined ? null : (
                <span className="stepper__time">
                  {fill(en.tx.timestamp, {time: TIME_FORMAT.format(new Date(entry.at))})}
                </span>
              )}
              {entry?.hash != null && explorer !== null ? (
                <a href={explorer} target="_blank" rel="noreferrer noopener">
                  {en.app.openInExplorer}
                </a>
              ) : null}
            </li>
          );
        })}
      </ol>

      {state.phase === "included" ? <StateBadge tone="pending" label={en.tx.provisional} /> : null}

      <p>{phaseMessage(state)}</p>

      {state.failure === null ? null : (
        <div className="stack small">
          {/* Wallet-authored text, labelled as the wallet's rather than printed as the app's sentence. */}
          {state.failure.walletText == null ? null : (
            <p className="muted">
              {en.wallet.errorSaidLabel} {state.failure.walletText}
            </p>
          )}
          <p className="muted">{fill(en.tx.funds, {funds: state.failure.funds})}</p>
          <p>{fill(en.tx.nextAction, {next: state.failure.nextAction})}</p>
          {state.failure.selector === null ? null : (
            <p className="mono smallest">
              {en.tx.selectorLabel}: {state.failure.selector}
            </p>
          )}
          {state.failure.data === null ? null : (
            <p className="mono smallest">
              {en.tx.dataLabel}: {state.failure.data}
            </p>
          )}
        </div>
      )}

      {state.hash === null ? null : (
        <p className="mono smallest muted">
          {en.tx.hashLabel}: {state.hash}
        </p>
      )}

      {state.phase === "replaced" || state.phase === "dropped" ? (
        <p className="small muted">{en.tx.neverResend}</p>
      ) : null}
    </div>
  );
}
