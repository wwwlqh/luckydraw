// Telling one provider refusal from another, and how long to wait before asking again (SPEC §10.1).
//
// Every log scan in this repo - the web app's entries discovery and the keeper's buyer discovery - pages
// `eth_getLogs` and has to answer the same question when a page fails: was the *query* too big, is this
// caller asking too often, or does this node simply not have those blocks any more? The three failures need
// different responses. A range cap is fixed by halving the window; a rate limit is not, because a narrower
// window is still one more request per second, and halving against a throttled node just burns the halving
// budget and reports a raw provider string. BSC's `data-seed-prebsc-*` endpoints answer every `eth_getLogs`
// with JSON-RPC -32005 "limit exceeded" whatever the range, which is exactly the case halving cannot win.
// Pruned history answers neither: publicnode drops logs below a rolling height and says so with -32701, and
// no window and no wait will bring them back, so a scan moves past that range and labels it.
//
// This module is the shared classifier and backoff schedule. It owns no transport and no paging policy: the
// callers decide what to do with the answer, so the web scan and the keeper scan can differ in windows,
// budgets and error surfaces while agreeing on what the node actually said.

/**
 * What a provider refusal actually was.
 *
 * `rangeCap`  - the node will not answer a range this wide or a result set this large. A narrower window is
 *   the fix, so the caller halves the window and re-reads the same start.
 * `rateLimit` - the node would have answered but is throttling this caller (JSON-RPC -32005, HTTP 429, or
 *   the usual wordings). A narrower window does not help, so the caller retries the same range after a wait.
 * `pruned` - the node no longer holds the blocks this query asked for. Free public endpoints keep only a
 *   rolling window of logs: `bsc-testnet-rpc.publicnode.com` answered JSON-RPC -32701 for every range below
 *   about block 131,577,900 on 2026-09-18. Neither halving nor waiting can fix it, because the data is gone
 *   from that node; the only answers are an archive-capable RPC, the indexer, or reading the newest history
 *   and labelling the rest as unavailable.
 * `unknown` - anything else. Callers treat it as they did before this distinction existed.
 */
export type ProviderErrorKind = "rangeCap" | "rateLimit" | "pruned" | "unknown";

/** Wordings that mean "this one query asked for too much", from the common public nodes. */
const RANGE_CAP_TEXT =
  /exceed(?:s|ed)?\s+max(?:imum)?\s+block\s+range|max(?:imum)?\s+(?:\[?from|block\s+range)|block\s+range\s+(?:is\s+)?too\s+(?:large|wide|big)|range\s+(?:is\s+)?too\s+(?:large|wide|big)|query\s+returned\s+more\s+than|returned\s+more\s+than\s+\d+\s+results|log(?:s)?\s+matched\s+by\s+(?:the\s+)?query|response\s+size\s+exceed|too\s+many\s+(?:logs|results|records)|result\s+set\s+too\s+large|ranges?\s+over\s+\d+\s+blocks/i;

/**
 * Wordings that mean "those blocks are gone from this node".
 *
 * Deliberately narrow. Every alternative names either pruning itself, the absence of history, or an age
 * boundary; none of them appears in a range-cap or rate-limit sentence from the nodes this repo has met.
 */
const PRUNED_TEXT =
  /prun|history\s+(?:is\s+)?(?:not\s+|un)available|beyond\s+(?:the\s+)?(?:archive|retention)|older\s+than/i;

/** Wordings that mean "you are asking too often". */
const RATE_LIMIT_TEXT =
  /limit\s+exceeded|rate[-\s]?limit|ratelimit|too\s+many\s+requests|request\s+limit|exceeded\s+(?:the\s+)?(?:request|quota|capacity)|throttl|try\s+again\s+later|capacity\s+exceeded|over\s+(?:rate|compute)\s+limit/i;

/** Every numeric code this error carries: its own, ethers' nested ones, an HTTP status, and any in the text. */
function providerCodes(error: unknown, depth = 0): number[] {
  const found: number[] = [];
  if (depth > 4) return found;
  if (typeof error === "string") {
    // ethers folds the node's JSON body into its own message text, so the code is often only a substring.
    for (const match of error.matchAll(/"(?:code|status)"\s*:\s*(-?\d+)/g)) found.push(Number(match[1]));
    return found;
  }
  if (error === null || typeof error !== "object") return found;
  const record = error as Record<string, unknown>;
  for (const field of ["code", "status", "statusCode", "responseStatus"]) {
    const value = record[field];
    if (typeof value === "number") found.push(value);
  }
  for (const field of ["error", "info", "cause", "data"]) {
    found.push(...providerCodes(record[field], depth + 1));
  }
  for (const field of ["message", "shortMessage"]) {
    const value = record[field];
    if (typeof value === "string") found.push(...providerCodes(value, depth + 1));
  }
  return found;
}

/**
 * Everything the provider wrote, flattened into one string.
 *
 * ethers wraps a node's body in its own "could not coalesce error" message and hangs the original off
 * `info`/`error`/`cause`, so the wording that matters is rarely on the top-level `message`.
 */
export function providerErrorText(error: unknown, depth = 0): string {
  if (error === null || error === undefined || depth > 4) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const field of ["message", "shortMessage", "reason"]) {
    const value = record[field];
    if (typeof value === "string") parts.push(value);
  }
  for (const field of ["error", "info", "cause"]) {
    const nested = record[field];
    if (nested !== undefined && nested !== null) parts.push(providerErrorText(nested, depth + 1));
  }
  return parts.join(" ");
}

/**
 * Splits a provider refusal into the four kinds above (SPEC §10.1).
 *
 * Order matters and is not alphabetical. -32701 is the dedicated "these blocks are pruned" code and is
 * decisive whatever the sentence around it says. The pruning wordings come next, because a node that has
 * dropped the blocks often says so in a sentence that also mentions the block range, and answering that with
 * a halving spends the whole halving budget on data the node will never have. The range wordings are third:
 * "limit exceeded" is a bare rate limit on BSC's data seeds, but the same substring also appears inside
 * longer range-cap sentences, and answering a range cap with a wait would stall a scan that a halving would
 * have finished.
 */
export function classifyProviderError(error: unknown): ProviderErrorKind {
  const text = providerErrorText(error);
  const codes = providerCodes(error);
  // -32701 is the JSON-RPC code publicnode returns for a range below its rolling log-retention height.
  if (codes.includes(-32701)) return "pruned";
  if (PRUNED_TEXT.test(text)) return "pruned";
  if (RANGE_CAP_TEXT.test(text)) return "rangeCap";
  // -32005 is the JSON-RPC "limit exceeded" code and 429 its HTTP spelling. A node that reports a range cap
  // as -32000 with block-range text was already caught by the range test above.
  if (codes.includes(-32005) || codes.includes(429)) return "rateLimit";
  if (RATE_LIMIT_TEXT.test(text)) return "rateLimit";
  return "unknown";
}

/** The first wait after a rate limit, before jitter. */
export const RATE_LIMIT_BACKOFF_MS = 1_000;

/** Ceiling for the rate-limit wait: the same 15 s the transaction machine backs off to (SPEC §10.1). */
export const RATE_LIMIT_BACKOFF_MAX_MS = 15_000;

/**
 * The wait before the nth rate-limited retry: 1 s doubling to a 15 s ceiling, with half-jitter.
 *
 * The jitter is not decoration. Every tab on this deployment, and the keeper beside them, start their scans
 * against the same shared public endpoint, so an unjittered backoff would line them all up on the same
 * second and reproduce the very limit it is waiting out.
 */
export function rateLimitDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RATE_LIMIT_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), RATE_LIMIT_BACKOFF_MAX_MS);
  // Half fixed, half random: never a zero wait, never more than the ceiling.
  return Math.round(base / 2 + (base / 2) * random());
}
