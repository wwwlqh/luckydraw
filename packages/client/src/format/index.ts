/// Display formatting for the app, the Verify page and the operator tools (SPEC §9.7).
///
/// Three rules hold across the whole module: the arithmetic is exact bigint arithmetic and never floating
/// point; the rounding direction is always the caller's explicit choice, because debits and fees round up
/// while prizes and shares round down; and every locale and time zone is passed in explicitly, so nothing
/// follows the process or browser default.

export * from "./date.ts";
export * from "./number.ts";
export * from "./percent.ts";
export * from "./units.ts";
