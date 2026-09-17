// The one button (SPEC §9.3: default, hover, focus-visible, active, disabled, loading and error states).
//
// Two rules it enforces for every caller:
//
//  - §9.1 X3, "one primary action": `variant="primary"` is the highlighted action of a page state, and a
//    surface should have exactly one;
//  - a control that cannot act says why. `disabledReason` disables the button and attaches the reason as its
//    accessible description, which is what `useWriteGate` feeds it, so a disabled money control is never a
//    dead end (§9.1 X4).

import {type ButtonHTMLAttributes, type ReactNode, useId} from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "type"> & {
  variant?: ButtonVariant;
  /** Renders a spinner and disables the control. The label stays readable; it is never replaced. */
  loading?: boolean;
  /** Disables the control and shows this sentence under it as the reason (SPEC §9.2 network guard). */
  disabledReason?: string | null;
  block?: boolean;
  type?: "button" | "submit";
  children: ReactNode;
};

export function Button({
  variant = "secondary",
  loading = false,
  disabledReason = null,
  block = false,
  type = "button",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const reasonId = useId();
  const isDisabled = disabled === true || loading || disabledReason !== null;
  const classes = ["button", `button--${variant}`];
  if (block) classes.push("button--block");
  return (
    <>
      <button
        {...rest}
        type={type}
        className={classes.join(" ")}
        disabled={isDisabled}
        aria-busy={loading || undefined}
        aria-describedby={disabledReason === null ? rest["aria-describedby"] : reasonId}
      >
        {loading ? <span className="button__spinner" aria-hidden="true" /> : null}
        {children}
      </button>
      {disabledReason === null ? null : (
        <span id={reasonId} className="small muted">
          {disabledReason}
        </span>
      )}
    </>
  );
}
