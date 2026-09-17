// The app-level error boundary (SPEC §9.1 X4: no dead ends).
//
// A render failure must still say what happened to money, because the honest answer is always the same here:
// a page that failed to render never sent anything. React only supports class components for this.

import {Component, type ErrorInfo, type ReactNode} from "react";
import {en} from "../strings/en.ts";

type Props = {children: ReactNode};
type State = {error: Error | null};

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {error: null};

  static getDerivedStateFromError(error: Error): State {
    return {error};
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No third-party reporter: SPEC §9.7 keeps analytics off until the viewer opts in, and nothing in an
    // error report may carry an address or an amount.
    console.error("LuckyDraw render failure", error, info.componentStack);
  }

  override render(): ReactNode {
    const {error} = this.state;
    if (error === null) return this.props.children;
    return (
      <main className="main">
        <div className="state-panel state-panel--error" role="alert">
          <h1 className="state-panel__title">{en.error.boundaryTitle}</h1>
          <p>{en.error.boundaryBody}</p>
          <p className="mono smallest">
            {en.error.detail}: {error.message}
          </p>
          <button type="button" className="button button--secondary" onClick={() => location.reload()}>
            {en.error.reload}
          </button>
        </div>
      </main>
    );
  }
}
