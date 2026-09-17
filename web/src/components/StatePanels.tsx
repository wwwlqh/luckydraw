// Empty and error panels (SPEC §9.1 X4 "Recoverable": "Every failure names its cause, keeps the user's
// input and offers a next step. No dead ends.").
//
// `ErrorState` is the only place in the app that renders a failure, so every failure gets a cause, a funds
// effect where one is known and a next action; nothing renders a bare stack trace.

import type {ReactNode} from "react";
import {en} from "../strings/en.ts";
import {Button} from "./Button.tsx";

export type EmptyStateProps = {
  title?: string;
  body?: string;
  action?: ReactNode;
};

export function EmptyState({title = en.empty.title, body = en.empty.body, action}: EmptyStateProps) {
  return (
    <div className="state-panel">
      <p className="state-panel__title">{title}</p>
      <p className="muted">{body}</p>
      {action}
    </div>
  );
}

export type ErrorStateProps = {
  title?: string;
  /** The cause, in plain words. */
  body: string;
  /** One of the fixed funds phrases of SPEC §9.6, when the failure has a known funds effect. */
  funds?: string | null;
  /** What the reader can do next, in words. */
  nextAction?: string | null;
  /** Copyable evidence for an unrecognized failure (§9.6). */
  detail?: string | null;
  onRetry?: (() => void) | undefined;
  retryLabel?: string;
};

export function ErrorState({
  title = en.error.title,
  body,
  funds = null,
  nextAction = null,
  detail = null,
  onRetry,
  retryLabel = en.app.retry,
}: ErrorStateProps) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <p className="state-panel__title">{title}</p>
      <p>{body}</p>
      {funds === null ? null : <p className="small muted">{funds}</p>}
      {nextAction === null ? null : <p className="small">{nextAction}</p>}
      {detail === null ? null : (
        <p className="mono smallest muted">
          {en.error.detail}: {detail}
        </p>
      )}
      {onRetry === undefined ? null : (
        <Button variant="secondary" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
