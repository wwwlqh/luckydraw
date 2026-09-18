// The HTTPS transport every RPC request goes through, built on `node:https` and nothing else.
//
// Why this file exists (field finding, 2026-09-18, Oracle Linux 9.7 aarch64, SELinux enforcing):
//
//   Under the hardened unit V8 cannot map its code range, so Node dies at start-up with
//   `# Fatal error in , line 0 # Check failed: 12 == (*__errno_location ()).` (SIGTRAP in
//   node::NewIsolate). `node --jitless` boots - but jitless Node has no WebAssembly, and Node's global
//   `fetch` is undici, whose HTTP parser *is* a WebAssembly module (llhttp). Any request through it fails
//   with `TypeError: fetch failed` whose cause is `WebAssembly is not defined`, which reached the operator
//   as `refused_to_start reason="eth_chainId could not be read: "` - an empty message, because the
//   `TypeError` carries its explanation in `cause` and not in `message`.
//
// ethers ships two `getUrl` implementations and picks one by build condition: `geturl.js` (node:http) and
// `geturl-browser.js` (global `fetch`). Which of the two a given install resolves is not something the
// keeper should depend on, and the browser one cannot work jitless at all. So the keeper registers its own
// and stops guessing: after `installNodeHttpTransport()` every `FetchRequest` in the process - the
// provider's `eth_*` calls included - goes through `node:https`, which needs no WebAssembly and no undici.
//
// It is installed unconditionally, not behind a flag. A flag would mean the transport that runs on the
// operator's host is not the transport the tests and the local dry-run exercise, which is exactly the class
// of difference that produced the empty-message refusal above; and a single implementation also removes
// undici's behavioural differences (header casing, its own timeouts, its own connection pool) from the
// picture. `node --jitless` costs a keeper nothing: it sends a few dozen JSON-RPC requests a minute and
// spends its time waiting on sockets, not in generated code.
//
// Secrecy rule, unchanged: an operator RPC URL usually carries its API key. Nothing here ever puts `req.url`
// into an error message or a log line; the only network detail that can surface is what `node:net` itself
// says (`connect ECONNREFUSED 1.2.3.4:443`), which is a host and a port and never a path or a query.

import {request as httpRequest} from "node:http";
import {request as httpsRequest} from "node:https";
import {gunzipSync} from "node:zlib";
import {FetchRequest} from "ethers";

/** ethers' `GetUrlResponse`, restated so this module does not import a type that is `@_ignore`d. */
export type TransportResponse = {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: null | Uint8Array;
};

/** The half of ethers' `FetchRequest` a transport reads. Stated structurally so tests need no real one. */
export type TransportRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: null | Uint8Array;
  timeout: number;
};

/** ethers' cancel signal, structurally: a cancelled request must not be sent and an in-flight one aborted. */
export type TransportSignal = {
  cancelled: boolean;
  addListener(listener: () => void): void;
};

/**
 * A non-empty description of a failure, for a transport error that must never be blank.
 *
 * `new TypeError("fetch failed")` is the friendly case; the one that cost an afternoon is an error whose
 * `message` is empty and whose meaning is in `cause`, because everything upstream formats `error.message`.
 * Falls through message, cause, code and finally the constructor name, so the result is always something an
 * operator can grep for.
 */
export function describeError(error: unknown): string {
  if (typeof error === "string" && error !== "") return error;
  if (!(error instanceof Error)) return String(error ?? "unknown error");
  if (error.message !== "") return error.message;
  const cause = (error as {cause?: unknown}).cause;
  if (cause !== undefined && cause !== null) {
    const described = describeError(cause);
    if (described !== "") return `${error.name || "Error"}: ${described}`;
  }
  const code = (error as {code?: unknown}).code;
  if (typeof code === "string" && code !== "") return `${error.name || "Error"} (${code})`;
  return error.name || "an error with no message";
}

class TransportError extends Error {
  constructor(message: string, options?: {cause?: unknown}) {
    super(message, options);
    this.name = "TransportError";
  }
}

/** One chunk list to one `Uint8Array`, or null when the response had no body at all. */
function concat(chunks: readonly Buffer[]): null | Uint8Array {
  if (chunks.length === 0) return null;
  return new Uint8Array(Buffer.concat(chunks as Buffer[]));
}

/**
 * Sends one request over `node:http`/`node:https` and resolves ethers' `GetUrlResponse` shape.
 *
 * Honours the method, the headers, the body and `req.timeout` (as both a connection/inactivity timeout and
 * the deadline for the complete response), and gunzips a `content-encoding: gzip` response exactly as
 * ethers' own node implementation does - `allowGzip` defaults to true, so a public RPC will send one.
 *
 * A non-2xx status is *not* an error here: ethers' `FetchResponse` is what decides that, and it needs the
 * status and the body to produce its own message.
 */
export async function sendOverNodeHttp(
  req: TransportRequest,
  signal?: TransportSignal,
): Promise<TransportResponse> {
  if (signal?.cancelled === true) throw new TransportError("request cancelled before sending");
  const protocol = req.url.split(":")[0]?.toLowerCase();
  if (protocol !== "http" && protocol !== "https") {
    // The scheme, never the URL: the rest of it is the credential.
    throw new TransportError(`unsupported protocol ${protocol ?? "(none)"}`);
  }
  const send = protocol === "http" ? httpRequest : httpsRequest;
  return await new Promise<TransportResponse>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      action();
    };
    const request = send(req.url, {method: req.method, headers: {...req.headers}});
    const fail = (error: unknown): void => {
      finish(() => {
        request.destroy();
        reject(error instanceof Error ? error : new TransportError(describeError(error)));
      });
    };
    // Both halves of the deadline. `setTimeout` covers a socket that goes quiet; the timer covers a server
    // that trickles bytes forever, which `setTimeout` alone would never end.
    if (req.timeout > 0) request.setTimeout(req.timeout);
    const deadline =
      req.timeout > 0
        ? setTimeout(() => fail(new TransportError("request timeout")), req.timeout)
        : undefined;
    // `unref` so a pending deadline cannot by itself hold the process open at shutdown.
    deadline?.unref?.();
    const done = (): void => {
      if (deadline !== undefined) clearTimeout(deadline);
    };
    request.on("timeout", () => {
      done();
      fail(new TransportError("request timeout"));
    });
    request.on("error", (error) => {
      done();
      // `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET`, a TLS failure: all of these have a message, but the
      // keeper's rule is that a refusal never prints an empty reason, so they go through `describeError`.
      fail(new TransportError(describeError(error), {cause: error}));
    });
    signal?.addListener(() => {
      done();
      fail(new TransportError("request cancelled"));
    });
    request.once("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      const statusMessage = response.statusMessage ?? "";
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", (error) => {
        done();
        fail(new TransportError(describeError(error), {cause: error}));
      });
      response.on("end", () => {
        done();
        let body = concat(chunks);
        try {
          if (headers["content-encoding"] === "gzip" && body !== null) {
            body = new Uint8Array(gunzipSync(body));
          }
        } catch (error) {
          fail(new TransportError(`bad response data: ${describeError(error)}`, {cause: error}));
          return;
        }
        finish(() => resolve({statusCode, statusMessage, headers, body}));
      });
    });
    if (req.body !== null && req.body.length > 0) request.write(Buffer.from(req.body));
    request.end();
  });
}

/** The heartbeat/alert sender's `fetch` surface (`notify.ts`'s `FetchLike`), restated to avoid a cycle. */
export type FetchInit = {
  method: string;
  body?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/** No deadline of its own is not an option; `notify.ts` passes an `AbortSignal.timeout` on top of this. */
const FETCH_TIMEOUT_MS = 30_000;

/**
 * The same transport in `fetch` clothing, for the heartbeat and the alert webhook.
 *
 * Those two are the keeper's other outbound requests, and on a jitless host Node's global `fetch` fails them
 * exactly as it failed the RPC - silently, as a `heartbeat_failed` line every cycle, which is a dead man's
 * switch that is dead. Only `ok` and `status` are read by the caller, so nothing else is returned.
 */
export async function fetchOverNodeHttp(
  url: string,
  init: FetchInit,
): Promise<{ok: boolean; status: number}> {
  const signal = init.signal;
  const bridge: TransportSignal = {
    get cancelled(): boolean {
      return signal?.aborted === true;
    },
    addListener(listener: () => void): void {
      signal?.addEventListener("abort", listener, {once: true});
    },
  };
  const response = await sendOverNodeHttp(
    {
      url,
      method: init.method,
      headers: {...init.headers},
      body: init.body === undefined ? null : new TextEncoder().encode(init.body),
      timeout: FETCH_TIMEOUT_MS,
    },
    bridge,
  );
  return {ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode};
}

let installed = false;

/**
 * Makes `sendOverNodeHttp` the transport for every `FetchRequest` in this process.
 *
 * Call it once, before the provider is built. Idempotent, because the test suite and `main` both call it and
 * ethers' registration is global; `FetchRequest.lockConfig()` is deliberately not called, so a future test
 * can still substitute its own.
 */
export function installNodeHttpTransport(): void {
  if (installed) return;
  installed = true;
  FetchRequest.registerGetUrl(
    sendOverNodeHttp as unknown as Parameters<typeof FetchRequest.registerGetUrl>[0],
  );
}
