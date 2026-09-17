// One copy control, shared by every surface that shows a value a reader has to compare somewhere else
// (SPEC §9.2: an address or a code hash is checked against a wallet or an explorer, so it has to be
// copyable without selecting text by hand).
//
// Accessibility notes that are not obvious:
//
//  * the button carries its own accessible name ("Copy Draw address"), because "Copy" on its own is
//    ambiguous the moment a page has more than one of these;
//  * the result is announced through a polite live region rather than by swapping the label, so a screen
//    reader hears "Copied" without the button losing the name it was focused by;
//  * `navigator.clipboard` is absent in an insecure context and rejects when permission is refused. Both
//    are ordinary outcomes here, not errors worth a dialog: the control simply does not report success.

import {useCallback, useState} from "react";
import {en, fill} from "../strings/en.ts";

export type CopyButtonProps = {
  /** The exact text placed on the clipboard. */
  value: string;
  /** What is being copied, for the accessible name: "Draw address", "code hash". */
  field: string;
};

export function CopyButton({value, field}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    const clipboard = navigator.clipboard;
    if (clipboard === undefined || clipboard === null) return;
    void clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
      })
      .catch(() => setCopied(false));
  }, [value]);

  return (
    <>
      <button
        type="button"
        className="icon-button"
        onClick={copy}
        aria-label={fill(en.pages.verify.copyField, {field})}
      >
        {en.app.copy}
      </button>
      <span role="status" aria-live="polite" className="visually-hidden">
        {copied ? en.app.copied : ""}
      </span>
    </>
  );
}
