// The heartbeat and the alert webhook: what is sent, what is suppressed, and what is never sent at all.
//
// `fetch` is faked, so nothing here opens a socket and the assertions are about the request the keeper
// would have made. The two URLs are treated as credentials throughout, which is why the last test is about
// what a failure puts in the log rather than about the failure itself.

import assert from "node:assert/strict";
import test from "node:test";
import {createLogger} from "./log.ts";
import {ALERT_REPEAT_MS, createNotifier, type FetchLike, NOTIFY_TIMEOUT_MS} from "./notify.ts";

const HEARTBEAT = "https://monitor.example/ping/0000-secret-token";
const WEBHOOK = "https://hooks.example/services/0000/secret";

type Call = {url: string; init: Parameters<FetchLike>[1]};

function recorder(response: {ok: boolean; status: number} | Error = {ok: true, status: 200}): {
  calls: Call[];
  fetch: FetchLike;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({url, init});
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

function harness(options: {heartbeat?: "GET" | "POST"; alerts?: boolean} = {}, response?: Error) {
  const {calls, fetch} = recorder(response ?? {ok: true, status: 200});
  const lines: string[] = [];
  let clock = 1_000_000;
  const notifier = createNotifier({
    heartbeat: options.heartbeat === undefined ? null : {url: HEARTBEAT, method: options.heartbeat},
    alertWebhook: options.alerts === true ? WEBHOOK : null,
    logger: createLogger({write: (line) => void lines.push(line)}),
    fetch,
    now: () => clock,
  });
  return {
    calls,
    lines,
    notifier,
    advance(ms: number): void {
      clock += ms;
    },
  };
}

test("neither signal is sent when the operator set neither variable (SPEC 14)", async () => {
  const {calls, notifier} = harness();
  notifier.heartbeat({block: 12n});
  notifier.alert("SeedNotAuthorized", {round: 1n});
  notifier.alert("consecutive_cycle_failures", {failures: 10});
  await notifier.drain();
  assert.deepStrictEqual(calls, [], "an unconfigured notifier opens no socket");
});

test("a GET heartbeat carries no body, a POST one carries the cycle summary", async () => {
  const get = harness({heartbeat: "GET"});
  get.notifier.heartbeat({block: 4242n, tracked: 2});
  await get.notifier.drain();
  assert.strictEqual(get.calls.length, 1);
  assert.strictEqual(get.calls[0]?.url, HEARTBEAT);
  assert.strictEqual(get.calls[0]?.init.method, "GET");
  assert.strictEqual(get.calls[0]?.init.body, undefined);

  const post = harness({heartbeat: "POST"});
  post.notifier.heartbeat({block: 4242n, tracked: 2});
  await post.notifier.drain();
  assert.strictEqual(post.calls[0]?.init.method, "POST");
  // Every chain integer crosses as a decimal string; JSON has no bigint (SPEC §10.1).
  assert.deepStrictEqual(JSON.parse(String(post.calls[0]?.init.body)), {
    ok: true,
    block: "4242",
    tracked: 2,
  });
});

test("every request carries a timeout, so a hung monitor cannot hold the cycle", async () => {
  const {calls, notifier} = harness({heartbeat: "GET"});
  notifier.heartbeat();
  await notifier.drain();
  const signal = calls[0]?.init.signal;
  assert.ok(signal instanceof AbortSignal, "an AbortSignal is attached");
  assert.ok(NOTIFY_TIMEOUT_MS > 0 && NOTIFY_TIMEOUT_MS <= 10_000, "the timeout is short");
});

test("an alert posts a chat-readable summary and the structured cause", async () => {
  const {calls, notifier} = harness({alerts: true});
  notifier.alert("request_precheck_failed", {round: 7n, skip: "InsufficientBalance"});
  await notifier.drain();
  assert.strictEqual(calls[0]?.url, WEBHOOK);
  assert.strictEqual(calls[0]?.init.method, "POST");
  const body = JSON.parse(String(calls[0]?.init.body)) as {
    text: string;
    cause: string;
    detail: Record<string, unknown>;
  };
  assert.strictEqual(body.cause, "request_precheck_failed");
  assert.match(body.text, /request_precheck_failed/);
  assert.match(body.text, /round=7/);
  assert.deepStrictEqual(body.detail, {round: "7", skip: "InsufficientBalance"});
});

test("one alert per cause per hour, and the hour is per cause", async () => {
  const h = harness({alerts: true});
  h.notifier.alert("SeedNotAuthorized", {round: 1n});
  h.notifier.alert("SeedNotAuthorized", {round: 2n});
  h.advance(ALERT_REPEAT_MS - 1);
  h.notifier.alert("SeedNotAuthorized", {round: 3n});
  // A different cause is never suppressed by the first one's window.
  h.notifier.alert("InsufficientSeedBalance", {round: 3n});
  await h.notifier.drain();
  assert.strictEqual(h.calls.length, 2, "the two repeats inside the hour were dropped");

  h.advance(1);
  h.notifier.alert("SeedNotAuthorized", {round: 4n});
  await h.notifier.drain();
  assert.strictEqual(h.calls.length, 3, "the hour having passed, the condition pages again");
});

test("a suppressed alert is silent; a sent one says so in the log", async () => {
  const h = harness({alerts: true});
  h.notifier.alert("subscription_below_threshold", {nativeBalanceWei: 1n});
  h.notifier.alert("subscription_below_threshold", {nativeBalanceWei: 1n});
  await h.notifier.drain();
  const sent = h.lines.filter((line) => line.includes("event=alert_sent"));
  assert.strictEqual(sent.length, 1, "the repeat inside the hour adds no line either");
  assert.match(sent[0] ?? "", /cause=subscription_below_threshold/);
});

test("a rejected status is a warning, not a throw", async () => {
  const {calls, fetch} = recorder({ok: false, status: 503});
  const lines: string[] = [];
  const notifier = createNotifier({
    heartbeat: {url: HEARTBEAT, method: "GET"},
    alertWebhook: null,
    logger: createLogger({write: (line) => void lines.push(line)}),
    fetch,
  });
  notifier.heartbeat();
  await notifier.drain();
  assert.strictEqual(calls.length, 1);
  assert.ok(
    lines.some((line) => line.includes("event=heartbeat_failed") && line.includes("status=503")),
    `the failure was not logged: ${lines.join("|")}`,
  );
});

test("an alert body never carries the RPC URL an ethers error quoted (F1)", async () => {
  // The exact shape of the field `keeper.ts` puts in `consecutive_cycle_failures`: ethers writes the request
  // URL into a provider error's message, and an operator RPC URL carries its key in the path.
  const message =
    'server response 500 (info={ "requestUrl": "https://bsc.example/v1/KEY" }, code=SERVER_ERROR)';
  const h = harness({alerts: true});
  h.notifier.alert("consecutive_cycle_failures", {failures: 10, error: message});
  await h.notifier.drain();
  const raw = String(h.calls[0]?.init.body);
  assert.ok(!raw.includes("KEY"), `the RPC key was posted to the webhook: ${raw}`);
  assert.ok(!/https?:\/\//.test(raw), `a URL reached the alert body: ${raw}`);
  assert.ok(raw.includes("<rpc>"), "the URL is replaced, not silently dropped");
  const body = JSON.parse(raw) as {text: string; detail: Record<string, unknown>};
  // Both halves of the payload: the structured field and the one-line summary a chat client renders.
  assert.ok(String(body.detail.error).includes("<rpc>"));
  assert.ok(body.text.includes("<rpc>"));
  assert.ok(String(body.detail.error).includes("code=SERVER_ERROR"), "the rest stays readable");
});

test("a POST heartbeat body is redacted the same way (F1)", async () => {
  const h = harness({heartbeat: "POST"});
  h.notifier.heartbeat({block: 4242n, note: "reconnected to https://bsc.example/v1/KEY"});
  await h.notifier.drain();
  const raw = String(h.calls[0]?.init.body);
  assert.ok(!raw.includes("KEY"), `the RPC key was posted to the monitor: ${raw}`);
  assert.deepStrictEqual(JSON.parse(raw), {ok: true, block: "4242", note: "reconnected to <rpc>"});
});

test("a network failure never publishes the endpoint it failed to reach", async () => {
  // `fetch` quotes the URL in its error, and a heartbeat URL is a bearer token in a path.
  const h = harness({heartbeat: "GET"}, new TypeError(`fetch failed for ${HEARTBEAT}`));
  h.notifier.heartbeat();
  await h.notifier.drain();
  const output = h.lines.join("\n");
  assert.ok(output.includes("event=heartbeat_failed"), `no failure line: ${output}`);
  assert.ok(!output.includes("secret-token"), "the credential in the URL must not be logged");
  assert.ok(output.includes("<rpc>"), "the URL is replaced, not silently dropped");
});
