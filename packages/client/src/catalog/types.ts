// Shapes and local enum-name unions for the externalized string catalog (SPEC §9.6, §9.7).
//
// The catalog is the only place English user-facing text for a revert, a quote reason, a seed-skip reason,
// a wallet condition or a round state is written. It never formats a number, a date or an address: a message
// carries `{name}` placeholders and the caller substitutes already-formatted strings through
// `renderMessage` (SPEC §9.7 keeps `Intl.NumberFormat` and the date format in `src/format/`).

/**
 * One catalog row: what happened, what it did to money, and the single next action.
 *
 * Every field is user-facing English. `message` is a plain sentence, `funds` is one of the fixed phrases
 * ("Nothing debited", "Nothing transferred", "No change", "Nothing sent", "Unknown until receipt") and
 * `nextAction` names exactly one thing the reader (or the operator, on admin surfaces) can do next.
 */
export type CatalogEntry = {
  /** Plain-language sentence. May contain `{name}` placeholders; never a raw selector or stack trace. */
  readonly message: string;
  /** What happened to funds, in the fixed vocabulary of SPEC §9.6. */
  readonly funds: string;
  /** One next action. */
  readonly nextAction: string;
  /** Placeholder names used by `message`, without braces, for example `["min", "symbol"]`. */
  readonly params?: readonly string[];
};

/** The minimum an entry needs for `renderMessage`; both `CatalogEntry` and `StateCatalogEntry` satisfy it. */
export type RenderableEntry = {
  readonly message: string;
  readonly params?: readonly string[];
};

/** One row of the SPEC §9.6 state table: the primary action label plus the message shown with it. */
export type StateCatalogEntry = {
  /** Label of the control the state offers, or "No action needed" when the state offers none. */
  readonly primaryAction: string;
  /** Plain-language sentence. May contain `{name}` placeholders. */
  readonly message: string;
  /** Second sentence the page shows under the message when it applies (seeded Void, non-winners). */
  readonly note?: string;
  /** Placeholder names used by `message`, without braces. */
  readonly params?: readonly string[];
};

/** The fixed funds vocabulary of SPEC §9.6. Every entry's `funds` is one of these. */
export const FUNDS_PHRASES = [
  "Nothing debited",
  "Nothing transferred",
  "No change",
  "Nothing sent",
  "Unknown until receipt",
] as const;

export type FundsPhrase = (typeof FUNDS_PHRASES)[number];

// The enum name unions come from the generated types (contracts/src/Types.sol in ABI order, written by
// scripts/generate.ts), so a renamed or reordered member fails here at compile time.
export type {QuoteReasonName, SeedSkipReasonName, StateName} from "../types/generated.ts";
