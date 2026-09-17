// The combined catalog and its lookup and substitution helpers (SPEC §9.6, §9.7).
//
// `catalog` is the one externalized English string catalog: every custom error, Panic code, QuoteReason,
// SeedSkipReason and wallet condition. `CatalogKey` is the union of its keys, so a mistyped key is a type
// error rather than a missing message at runtime. Round states live in `stateCatalog` (`states.ts`) because
// their rows carry a primary action label instead of a funds effect.
//
// The catalog never formats a number, a date or an address (SPEC §9.7 keeps that in `src/format/`): a
// message carries `{name}` placeholders and `renderMessage` substitutes already-formatted strings.

import {errorCatalog} from "./errors.ts";
import {panicCatalog} from "./panics.ts";
import {quoteReasonCatalog} from "./quoteReasons.ts";
import {seedSkipCatalog} from "./seedSkips.ts";
import type {CatalogEntry, RenderableEntry} from "./types.ts";
import {walletCatalog} from "./wallet.ts";

export const catalog = {
  ...errorCatalog,
  ...panicCatalog,
  ...quoteReasonCatalog,
  ...seedSkipCatalog,
  ...walletCatalog,
} satisfies Record<string, CatalogEntry>;

/** Every key the catalog answers for: error names, `Panic:0x11`, `Quote:BelowMinimum`, `SeedSkip:NotOpen`, wallet conditions. */
export type CatalogKey = keyof typeof catalog;

/** Every catalog key, sorted, for iteration in tests and admin surfaces. */
export const CATALOG_KEYS: readonly CatalogKey[] = Object.keys(catalog).sort() as CatalogKey[];

/** `{name}` placeholders, where `name` starts with a letter and continues with letters, digits or `_`. */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

/** Thrown by `renderMessage` when a placeholder the entry declares has no value. */
export class CatalogRenderError extends Error {
  /** The declared placeholder names that had no value, in declaration order. */
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Missing catalog message parameters: ${missing.join(", ")}`);
    this.name = "CatalogRenderError";
    this.missing = missing;
  }
}

/** The entry for a catalog key. The key union makes every call total, so there is no `undefined` branch. */
export const catalogEntryFor = (key: CatalogKey): CatalogEntry => catalog[key];

/** Whether an arbitrary string (a decoded error name, a reason key) is a catalog key. */
export const hasCatalogEntry = (name: string): name is CatalogKey => Object.hasOwn(catalog, name);

/**
 * Substitute `{name}` placeholders in an entry's message with already-formatted strings.
 *
 * Every placeholder the entry declares in `params` must have a value: a missing one throws
 * `CatalogRenderError` rather than printing `{gross}` or `undefined` next to money. A placeholder that is
 * not declared is left untouched, so an unexpected brace in text can never be silently blanked.
 */
export const renderMessage = (
  entry: RenderableEntry,
  params: Readonly<Record<string, string>> = {},
): string => {
  const missing = (entry.params ?? []).filter((name) => params[name] === undefined);
  if (missing.length > 0) throw new CatalogRenderError(missing);
  return entry.message.replace(PLACEHOLDER, (match: string, name: string): string => {
    const value = params[name];
    return value === undefined ? match : value;
  });
};
