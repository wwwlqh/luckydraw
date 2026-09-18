// The shared classification of provider refusals and the rate-limit backoff schedule (SPEC §10.1).
//
// The web scan and the keeper scan both branch on `classifyProviderError`, so the wordings and shapes real
// nodes produce are pinned here once, next to the implementation, rather than in either caller.

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyProviderError,
  prunedEvidence,
  RATE_LIMIT_BACKOFF_MAX_MS,
  rateLimitDelayMs,
} from "./providerError.ts";

test("a bare JSON-RPC -32005 is a rate limit, at any depth ethers wraps it", () => {
  assert.strictEqual(classifyProviderError({code: -32005, message: "limit exceeded"}), "rateLimit");
  assert.strictEqual(
    classifyProviderError(
      // The shape ethers produces for a data-seed refusal: its own message, the node's body on `info`.
      Object.assign(new Error("could not coalesce error"), {
        info: {error: {code: -32005, message: "limit exceeded"}},
      }),
    ),
    "rateLimit",
  );
  assert.strictEqual(classifyProviderError({status: 429, message: "Too Many Requests"}), "rateLimit");
});

test("a range refusal is a range cap even when it says 'limit exceeded'", () => {
  assert.strictEqual(
    classifyProviderError(new Error("eth_getLogs: query returned more than 10000 results")),
    "rangeCap",
  );
  assert.strictEqual(
    classifyProviderError({code: -32000, message: "exceed maximum block range: 5000"}),
    "rangeCap",
  );
  // A node that words its block-range cap as a limit that was exceeded must still halve, never wait.
  assert.strictEqual(
    classifyProviderError({code: -32005, message: "block range limit exceeded, ranges over 1000 blocks"}),
    "rangeCap",
  );
});

test("publicnode's -32701 is pruned history, whatever the sentence around it says", () => {
  // The exact body `https://bsc-testnet-rpc.publicnode.com` returned for `eth_getLogs` over any range below
  // its rolling retention height, measured 2026-09-18 (that day the height was about block 131,577,900).
  const publicnode = {
    code: -32701,
    message:
      "History has been pruned for this block. To remove restrictions, order a dedicated full node here: " +
      "https://www.allnodes.com/bsc-testnet/host",
  };
  assert.strictEqual(classifyProviderError(publicnode), "pruned");
  assert.strictEqual(
    prunedEvidence(publicnode),
    "code",
    "the node named the code, so nothing else is needed",
  );
  assert.strictEqual(
    classifyProviderError(
      // The shape ethers produces around it: its own message on top, the node's body on `info`.
      Object.assign(new Error("could not coalesce error"), {info: {error: publicnode}}),
    ),
    "pruned",
  );
  // Constructed, not measured: the point is that the code decides even when the sentence reads like a range
  // cap, which is exactly the sentence a halving would otherwise chase.
  assert.strictEqual(
    classifyProviderError({code: -32701, message: "block range too large for pruned history"}),
    "pruned",
  );
});

test("a pruning wording never steals a range cap or a rate limit", () => {
  // The three probes from the 2026-09-18 review of the pruned-log handling. Each is a refusal that is NOT
  // about pruning but contains a pruning wording, and reading any of them as pruned makes the web scan step
  // over blocks the node would have served while still reporting a complete history.
  assert.strictEqual(
    // A provider capping the range at 5 blocks. "older than" here counts blocks, not age.
    classifyProviderError({
      code: -32000,
      message: "block range too large: cannot query logs older than 5 blocks",
    }),
    "rangeCap",
  );
  assert.strictEqual(
    classifyProviderError({code: 429, message: "history unavailable, please retry"}),
    "rateLimit",
  );
  assert.strictEqual(
    classifyProviderError({
      code: -32600,
      message: "eth_getLogs is limited to 3000 blocks; query older than the limit",
    }),
    "rangeCap",
  );
});

test("the pruning wordings are pruned without a code, but only as wording", () => {
  // Constructed sentences, not transcripts: no node in this repo's evidence produced them. They stand for
  // the shapes a node might use when it has no dedicated code, and `prunedEvidence` marks every one of them
  // as wording-only so a caller can demand corroboration before acting.
  for (const message of [
    "logs have been pruned for this range",
    "history is not available before block 131577900",
    "requested range is beyond the archive window",
    "blocks older than 128 are not retained by this node",
  ]) {
    assert.strictEqual(classifyProviderError(new Error(message)), "pruned", message);
    assert.strictEqual(prunedEvidence(new Error(message)), "text", message);
  }
  // Regression: an ordinary range cap and an ordinary rate limit must not drift into the new kind.
  assert.strictEqual(classifyProviderError({code: -32000, message: "block range is too large"}), "rangeCap");
  assert.strictEqual(classifyProviderError({code: -32005, message: "limit exceeded"}), "rateLimit");
  assert.strictEqual(prunedEvidence({code: -32000, message: "block range is too large"}), null);
});

test("drpc's free-plan refusals are a range cap or unknown, never pruned", () => {
  // Re-probed 2026-09-18 against https://bsc-testnet.drpc.org with curl, `eth_getLogs` on the chain-97 Draw
  // 0x25c4…1d41. The earlier note in this repo said code 3; that is not what it answers today. A span of
  // 102 blocks or more is refused with code 35 and the sentence below — whatever the span actually is, so
  // the "10000" in it is not the real cap — and a span of 101 blocks or fewer, down to a single block, is
  // refused with code 19. Either way not one log came back, on any range.
  assert.strictEqual(
    classifyProviderError({code: 35, message: "ranges over 10000 blocks are not supported on free plan"}),
    "rangeCap",
  );
  const temporary = {
    code: 19,
    message: "Temporary internal error. Please retry, trace-id: 269e25762d741c0436cbfe521870ad18",
  };
  // Nothing in it says the blocks are gone and nothing says this caller is throttled, so the scan must not
  // record a history boundary from it and must not wait it out as a rate limit: it halves, then reports.
  assert.strictEqual(classifyProviderError(temporary), "unknown");
  assert.strictEqual(prunedEvidence(temporary), null);
});

test("anything else is unknown, so callers keep their previous behaviour", () => {
  assert.strictEqual(classifyProviderError(new Error("connect ECONNREFUSED")), "unknown");
  assert.strictEqual(classifyProviderError(null), "unknown");
});

test("the backoff doubles from 1 s to a 15 s ceiling and never waits zero", () => {
  const top = (attempt: number) => rateLimitDelayMs(attempt, () => 1);
  const bottom = (attempt: number) => rateLimitDelayMs(attempt, () => 0);
  assert.deepStrictEqual([top(1), top(2), top(3), top(4)], [1_000, 2_000, 4_000, 8_000]);
  assert.deepStrictEqual([bottom(1), bottom(2)], [500, 1_000]);
  assert.strictEqual(top(20), RATE_LIMIT_BACKOFF_MAX_MS, "the wait is capped however many retries there are");
  assert.ok(bottom(20) > 0, "a jitter of zero is still a wait");
});
