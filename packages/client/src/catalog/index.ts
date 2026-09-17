// Public surface of the string catalog (SPEC §9.6, §9.7): one place for every user-facing sentence the app
// shows for a revert, a quote reason, a seed-skip reason, a wallet condition or a round state.

export type {ErrorCatalogKey} from "./errors.ts";
export {errorCatalog} from "./errors.ts";
export type {PanicCatalogKey} from "./panics.ts";
export {PANIC_CODES, panicCatalog, panicCatalogKey} from "./panics.ts";
export type {QuoteReasonCatalogKey} from "./quoteReasons.ts";
export {quoteReasonCatalog, quoteReasonCatalogKey} from "./quoteReasons.ts";
export type {CatalogKey} from "./render.ts";
export {
  CATALOG_KEYS,
  CatalogRenderError,
  catalog,
  catalogEntryFor,
  hasCatalogEntry,
  renderMessage,
} from "./render.ts";
export type {SeedSkipCatalogKey} from "./seedSkips.ts";
export {seedSkipCatalog, seedSkipCatalogKey} from "./seedSkips.ts";
export type {StateCatalogKey} from "./states.ts";
export {
  DRAWING_WAITING_NOTICE_SECONDS,
  STATE_CATALOG_KEYS_BY_STATE,
  stateCatalog,
  stateCatalogKeyFor,
} from "./states.ts";
export type {CatalogEntry, FundsPhrase, RenderableEntry, StateCatalogEntry} from "./types.ts";
export {FUNDS_PHRASES} from "./types.ts";
export type {WalletCatalogKey} from "./wallet.ts";
export {walletCatalog} from "./wallet.ts";
