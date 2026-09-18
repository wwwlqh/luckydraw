// The node:https transport, against a real `node:http` server.
//
// Everything here is the transport's contract with ethers: the status line, the headers, the body in both
// directions, a deadline that ends a request the server never answers, and - the reason this file exists at
// all - that a failure surfaces a message that is not empty. An operator reading `journalctl` got
// `refused_to_start reason="eth_chainId could not be read: "` when undici's WebAssembly parser was missing
// under `--jitless`; a blank reason is the one failure mode that leaves nothing to grep for.

import assert from "node:assert/strict";
import {createServer, type IncomingMessage, type Server, type ServerResponse} from "node:http";
import type {AddressInfo} from "node:net";
import test from "node:test";
import {gzipSync} from "node:zlib";
import {
  describeError,
  fetchOverNodeHttp,
  sendOverNodeHttp,
  type TransportRequest,
  type TransportSignal,
} from "./transport.ts";

/** A one-request server on a free port, and its base URL. */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{url: string; close: () => Promise<void>; server: Server}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const {port} = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/rpc`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function requestFor(url: string, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url,
    method: "POST",
    headers: {"content-type": "application/json"},
    body: new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'),
    timeout: 5_000,
    ...overrides,
  };
}

test("the transport round-trips method, headers, body, status and response headers", async () => {
  let seen: {method: string | undefined; header: string | undefined; body: string | undefined} = {
    method: undefined,
    header: undefined,
    body: undefined,
  };
  const {url, close} = await serve((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen = {
        method: req.method,
        header: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(200, "OK", {"content-type": "application/json", "x-node": "probe"});
      res.end('{"jsonrpc":"2.0","id":1,"result":"0x61"}');
    });
  });
  try {
    const response = await sendOverNodeHttp(requestFor(url));
    assert.strictEqual(seen.method, "POST");
    assert.strictEqual(seen.header, "application/json");
    assert.match(seen.body ?? "", /eth_chainId/);
    assert.strictEqual(response.statusCode, 200);
    assert.strictEqual(response.statusMessage, "OK");
    assert.strictEqual(response.headers["x-node"], "probe");
    assert.strictEqual(
      new TextDecoder().decode(response.body ?? new Uint8Array()),
      '{"jsonrpc":"2.0","id":1,"result":"0x61"}',
    );
  } finally {
    await close();
  }
});

test("a non-2xx status is returned, not thrown: ethers' FetchResponse decides that", async () => {
  const {url, close} = await serve((_req, res) => {
    res.writeHead(500, "Internal Server Error", {"content-type": "text/plain"});
    res.end("upstream is unwell");
  });
  try {
    const response = await sendOverNodeHttp(requestFor(url));
    assert.strictEqual(response.statusCode, 500);
    assert.strictEqual(response.statusMessage, "Internal Server Error");
    assert.strictEqual(new TextDecoder().decode(response.body ?? new Uint8Array()), "upstream is unwell");
  } finally {
    await close();
  }
});

test("a gzip-encoded response is decompressed, as a public RPC sends one", async () => {
  const payload = '{"jsonrpc":"2.0","id":1,"result":"0x61"}';
  const {url, close} = await serve((_req, res) => {
    res.writeHead(200, "OK", {"content-type": "application/json", "content-encoding": "gzip"});
    res.end(gzipSync(Buffer.from(payload, "utf8")));
  });
  try {
    const response = await sendOverNodeHttp(requestFor(url));
    assert.strictEqual(new TextDecoder().decode(response.body ?? new Uint8Array()), payload);
  } finally {
    await close();
  }
});

test("a GET with no body sends no body", async () => {
  let length: string | undefined = "unset";
  const {url, close} = await serve((req, res) => {
    length = req.headers["content-length"];
    res.writeHead(204, "No Content");
    res.end();
  });
  try {
    const response = await sendOverNodeHttp(requestFor(url, {method: "GET", body: null, headers: {}}));
    assert.strictEqual(response.statusCode, 204);
    assert.strictEqual(response.body, null);
    assert.strictEqual(length, undefined);
  } finally {
    await close();
  }
});

test("a server that never answers ends at the timeout, with a message", async () => {
  const {url, close} = await serve(() => {
    // Deliberately no response: the socket stays open and silent.
  });
  try {
    await assert.rejects(
      () => sendOverNodeHttp(requestFor(url, {timeout: 150})),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.strictEqual(error.message, "request timeout");
        return true;
      },
    );
  } finally {
    await close();
  }
});

test("a refused connection surfaces a message that is not empty and holds no URL", async () => {
  // A port that was listening and is not any more: a connect() that is refused rather than dropped.
  const {url, close} = await serve((_req, res) => res.end("unreachable"));
  await close();
  await assert.rejects(
    () => sendOverNodeHttp(requestFor(url)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notStrictEqual(error.message, "");
      assert.match(error.message, /ECONNREFUSED|ECONNRESET|EADDRNOTAVAIL/);
      assert.ok(!error.message.includes("/rpc"), `message leaked the path: ${error.message}`);
      return true;
    },
  );
});

test("a cancelled request is refused before it is sent", async () => {
  const signal: TransportSignal = {cancelled: true, addListener: () => {}};
  await assert.rejects(
    () => sendOverNodeHttp(requestFor("http://127.0.0.1:1/rpc"), signal),
    /request cancelled before sending/,
  );
});

test("a non-http scheme is refused by scheme alone, without quoting the URL", async () => {
  await assert.rejects(
    () => sendOverNodeHttp(requestFor("wss://example.invalid/secret-key")),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.strictEqual(error.message, "unsupported protocol wss");
      assert.ok(!error.message.includes("secret-key"));
      return true;
    },
  );
});

test("the heartbeat/alert fetch adapter reports ok and status, and honours an abort", async () => {
  // `notify.ts` takes this instead of the global `fetch`, which a jitless host cannot use at all.
  let status = 204;
  const {url, close} = await serve((_req, res) => {
    res.writeHead(status);
    res.end();
  });
  try {
    assert.deepStrictEqual(await fetchOverNodeHttp(url, {method: "GET"}), {ok: true, status: 204});
    status = 503;
    assert.deepStrictEqual(await fetchOverNodeHttp(url, {method: "GET"}), {ok: false, status: 503});
    const aborted = AbortSignal.abort();
    await assert.rejects(
      () => fetchOverNodeHttp(url, {method: "GET", signal: aborted}),
      /request cancelled before sending/,
    );
  } finally {
    await close();
  }
});

test("describeError falls through message, cause, code and name, and is never empty", () => {
  assert.strictEqual(describeError(new Error("plain")), "plain");
  // The exact shape that produced the blank refusal: `TypeError: fetch failed` under --jitless carries its
  // explanation only in `cause`.
  const wrapped = new TypeError("", {cause: new ReferenceError("WebAssembly is not defined")});
  assert.strictEqual(describeError(wrapped), "TypeError: WebAssembly is not defined");
  const coded = Object.assign(new Error(""), {code: "ECONNRESET"});
  assert.strictEqual(describeError(coded), "Error (ECONNRESET)");
  assert.strictEqual(describeError(new Error("")), "Error");
  assert.strictEqual(describeError(undefined), "unknown error");
});
