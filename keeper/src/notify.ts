// Heartbeat and alerts: the two outbound signals of SPEC §10.3, both off unless the operator sets a URL.
//
// Nothing here is a dependency of the keeper's decisions. A heartbeat that fails, times out, or is never
// configured changes no action the keeper takes, and neither does an alert - the condition that produced it
// is already a log line. That is deliberate: an unreachable monitor must not be able to stop the keeper from
// closing a round, so every request is started and never awaited by the cycle, carries a short
// `AbortSignal.timeout`, and can only ever produce another log line.
//
// Both URLs are credentials. A dead-man's-switch ping URL is a bearer token in a path and a chat webhook is
// the same; `log.ts` replaces every absolute `http(s)://...` in a logged string with `<rpc>`, so a failure
// message quoting the endpoint - which `fetch` does - cannot publish it.
//
// The same rule applies to what goes *out* of here, not only to what is logged about it. An alert body and a
// POST heartbeat body are built from log fields, and those fields carry node error messages that quote the
// RPC URL; `jsonFields` and `summarise` below run every string through the same `redactUrls`, so the one
// endpoint that is a secret cannot be posted to a monitor or a chat room.
//
// Alerts are rate-limited to one per cause per hour. The conditions this alerts on are per-round and
// per-cycle: an unauthorized seed account produces `SeedNotAuthorized` for every Open round of every pool,
// four times a minute, forever. Paging somebody once and then staying quiet until the hour is up is the
// difference between an alert and a denial of service against the operator's phone.

import {type LogFields, type Logger, redactUrls} from "./log.ts";

/** One alert per cause per hour (SPEC §10.3 "repeat interval"). */
export const ALERT_REPEAT_MS = 3_600_000;

/** Long enough for a monitor on another continent, short enough that a cycle never notices (SPEC §10.2). */
export const NOTIFY_TIMEOUT_MS = 5_000;

/**
 * Every condition that may page the operator.
 *
 * Deliberately a closed set: the rate limiter is keyed by it, so an alert built from a free-form string
 * (a revert reason, a node's message) would defeat the limiter the first time the string varied.
 */
export type AlertCause =
  | "consecutive_cycle_failures"
  | "request_precheck_failed"
  | "SeedNotAuthorized"
  | "InsufficientSeedBalance"
  | "subscription_below_threshold";

/** The `fetch` surface used here, so a test can serve it without a socket. */
export type FetchLike = (
  url: string,
  init: {method: string; body?: string; headers?: Record<string, string>; signal?: AbortSignal},
) => Promise<{ok: boolean; status: number}>;

export type Notifier = {
  /** After a healthy cycle. Returns immediately; the request finishes in the background. */
  heartbeat(fields?: LogFields): void;
  /** Sends unless the same cause was alerted within `ALERT_REPEAT_MS`. Returns immediately. */
  alert(cause: AlertCause, fields?: LogFields): void;
  /** Resolves when every started request has settled. For the fatal exit path, and for tests. */
  drain(): Promise<void>;
};

export type NotifierOptions = {
  heartbeat: {url: string; method: "GET" | "POST"} | null;
  alertWebhook: string | null;
  logger: Logger;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
};

/**
 * Log fields as a JSON-safe object: bigints become decimal strings, `undefined` is dropped, and every string
 * passes through `redactUrls`.
 *
 * The redaction is not decoration. The two fields that reach this function from the two loudest alerts are
 * free-form node messages: `consecutive_cycle_failures` carries the tenth cycle's error, and ethers writes
 * `info={ "requestUrl": "https://host/v1/<key>" ... }` into it, and `request_precheck_failed` carries an
 * undecodable `eth_estimateGas` failure, which does the same. `log.ts` redacts those on the way to stdout;
 * without the same pass here the keeper would post the operator's RPC key to a chat webhook - a third party,
 * in a searchable channel, which is worse than a log file on the host (SPEC §10.3).
 */
function jsonFields(fields: LogFields | undefined): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "bigint") out[key] = value.toString();
    else out[key] = typeof value === "string" ? redactUrls(value) : value;
  }
  return out;
}

/**
 * A one-line human summary, which is what a chat webhook shows before anyone expands the payload.
 *
 * Built from the already-redacted fields, and redacted once more: the summary is the part of the alert a
 * person reads and a chat client turns into a clickable link, so it is the last place a URL may survive.
 */
function summarise(cause: AlertCause, fields: Record<string, string | number | boolean | null>): string {
  const detail = Object.entries(fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return redactUrls(detail === "" ? `luckydraw keeper: ${cause}` : `luckydraw keeper: ${cause} ${detail}`);
}

/**
 * The heartbeat and alert sender. With both URLs null it is a working object that never opens a socket,
 * which is what lets `keeper.ts` call it unconditionally and `main.ts` hand it a configuration that did not
 * ask for either signal (SPEC §14: nothing is sent unless the operator sets the variable).
 */
export function createNotifier(options: NotifierOptions): Notifier {
  const {logger} = options;
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const now = options.now ?? ((): number => Date.now());
  const timeoutMs = options.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  const lastAlertAt = new Map<AlertCause, number>();
  const pending = new Set<Promise<void>>();

  /** Starts a request, records it for `drain`, and turns every possible outcome into a log line. */
  function send(kind: "heartbeat" | "alert", url: string, init: Parameters<FetchLike>[1]): void {
    const task = (async (): Promise<void> => {
      try {
        const response = await doFetch(url, {...init, signal: AbortSignal.timeout(timeoutMs)});
        if (!response.ok) logger.warn(`${kind}_failed`, {status: response.status});
      } catch (error) {
        // `redactUrls` in `log.ts` removes the endpoint that `fetch` puts in a network error's message.
        logger.warn(`${kind}_failed`, {error: error instanceof Error ? error.message : String(error)});
      }
    })();
    pending.add(task);
    void task.finally(() => void pending.delete(task));
  }

  return {
    heartbeat(fields?: LogFields): void {
      const config = options.heartbeat;
      if (config === null) return;
      const body = jsonFields(fields);
      send("heartbeat", config.url, {
        method: config.method,
        ...(config.method === "POST"
          ? {body: JSON.stringify({ok: true, ...body}), headers: {"content-type": "application/json"}}
          : {}),
      });
    },
    alert(cause: AlertCause, fields?: LogFields): void {
      const url = options.alertWebhook;
      if (url === null) return;
      const last = lastAlertAt.get(cause);
      const at = now();
      // The first occurrence of a cause pages immediately; the repeats within the hour are dropped in
      // silence, because the condition itself is logged every cycle it holds.
      if (last !== undefined && at - last < ALERT_REPEAT_MS) return;
      lastAlertAt.set(cause, at);
      const detail = jsonFields(fields);
      logger.warn("alert_sent", {cause, ...fields});
      send("alert", url, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({text: summarise(cause, detail), cause, detail}),
      });
    },
    async drain(): Promise<void> {
      await Promise.allSettled([...pending]);
    },
  };
}
