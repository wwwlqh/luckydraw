// Catalog rows for the Solidity `Panic(uint256)` codes the client decodes (SPEC §8.1, §9.6).
//
// SPEC §8.1: "Arithmetic overflow during execution surfaces as Solidity Panic(0x11) ... and the client
// decodes Panic codes as well as Vault and Draw custom errors." A panic is a contract-level failure, so the
// rows say plainly that the transaction was canceled, that nothing moved, and how to report it. A quote
// never panics: quoteBuy reports QuoteReason.ArithmeticOverflow instead (see `quoteReasons.ts`).

import type {CatalogEntry} from "./types.ts";

const reportNextAction = "Report it with the transaction hash";

export const panicCatalog = {
  "Panic:0x00": {
    message: "The transaction stopped on an internal check in the contract.",
    funds: "No change",
    nextAction: reportNextAction,
  },
  "Panic:0x01": {
    message: "An internal assertion in the contract failed, so the transaction was canceled.",
    funds: "No change",
    nextAction: reportNextAction,
  },
  "Panic:0x11": {
    message: "The amounts in this transaction are larger than the contract's arithmetic can hold.",
    funds: "No change",
    nextAction: "Reduce the amount and try again; report it with the transaction hash if it persists",
  },
  "Panic:0x12": {
    message: "The contract divided by zero, so the transaction was canceled.",
    funds: "No change",
    nextAction: reportNextAction,
  },
  "Panic:0x21": {
    message: "A value outside the list this contract accepts reached it, so the transaction was canceled.",
    funds: "No change",
    nextAction: reportNextAction,
  },
  "Panic:0x22": {
    message: "Stored data in the contract is encoded in a way it cannot read.",
    funds: "No change",
    nextAction: reportNextAction,
  },
  "Panic:0x31": {
    message: "The contract tried to take an item from an empty list.",
    funds: "No change",
    nextAction: reportNextAction,
  },
  "Panic:0x32": {
    message: "The contract tried to read past the end of a list.",
    funds: "No change",
    nextAction: "Reload the page and try again; report it with the transaction hash if it repeats",
  },
  "Panic:0x41": {
    message: "This request asked for more memory than the contract can use.",
    funds: "No change",
    nextAction:
      "Ask for a smaller page or a smaller amount; report it with the transaction hash if it persists",
  },
  "Panic:0x51": {
    message: "The contract called an internal function that was never set.",
    funds: "No change",
    nextAction: reportNextAction,
  },
} satisfies Record<string, CatalogEntry>;

export type PanicCatalogKey = keyof typeof panicCatalog;

/** Every Panic code the client decodes, in ascending order. */
export const PANIC_CODES = [0x00n, 0x01n, 0x11n, 0x12n, 0x21n, 0x22n, 0x31n, 0x32n, 0x41n, 0x51n] as const;

/**
 * The catalog key for a decoded `Panic(uint256)` code, or `undefined` for a code this catalog does not
 * cover (the caller then falls back to the `UnknownRevert` wallet row).
 */
export const panicCatalogKey = (code: bigint | number): PanicCatalogKey | undefined => {
  const value = BigInt(code);
  if (value < 0n || value > 0xffn) return undefined;
  const key = `Panic:0x${value.toString(16).padStart(2, "0")}`;
  return Object.hasOwn(panicCatalog, key) ? (key as PanicCatalogKey) : undefined;
};
