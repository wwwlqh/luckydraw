// The shared classification of provider refusals and the rate-limit backoff schedule (SPEC §10.1).
//
// The web scan and the keeper scan both branch on `classifyProviderError`, so the wordings and shapes real
// nodes produce are pinned here once, next to the implementation, rather than in either caller.

import assert from "node:assert/strict";
import test from "node:test";
import {classifyProviderError, RATE_LIMIT_BACKOFF_MAX_MS, rateLimitDelayMs} from "./providerError.ts";

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
