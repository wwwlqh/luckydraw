// What the process prints when it refuses to start, and what it must never print.
//
// The keeper holds two secrets: the signing key, which `config.test.ts` proves never enters any structure a
// log line can reach, and the RPC endpoint. An operator RPC URL usually carries its API key in the path or
// the query, and ethers puts the request URL into the message of a provider error - which `main` logs
// verbatim as the reason it refused to start, exactly as `keeper.ts` logs it as `cycle_failed`. This runs the
// real entry point against a real HTTP server that answers 500, so the message under test is ethers' own.

import assert from "node:assert/strict";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import test from "node:test";
import {formatValue, redactUrls} from "./log.ts";
import {main} from "./main.ts";

const DRAW = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const KEEPER_KEYS = [
  "KEEPER_RPC_URL",
  "KEEPER_CHAIN_ID",
  "KEEPER_DRAW_ADDRESS",
  "KEEPER_UNLOCKED_ADDRESS",
  "KEEPER_PRIVATE_KEY",
  "KEEPER_DEPLOYMENTS_DIR",
  "KEEPER_CHAINS_DIR",
  "KEEPER_INTERVAL_MS",
  "KEEPER_LOG_WINDOW",
  "KEEPER_DRY_RUN",
  "KEEPER_HEARTBEAT_URL",
  "KEEPER_HEARTBEAT_METHOD",
  "KEEPER_ALERT_WEBHOOK",
] as const;

/**
 * Runs `main` with the whole keeper environment replaced, capturing what it logs.
 *
 * Only the keeper's own lines are captured; everything else goes to the real stdout. Swallowing every write
 * would swallow the test runner's own output too - it reports a finished test on a later tick, so a
 * capturing test eats the *previous* test's result line and the run silently reports fewer tests than it
 * ran. `createLogger` writes `ts=...` lines and nothing else does.
 */
async function runMain(env: Partial<Record<(typeof KEEPER_KEYS)[number], string>>): Promise<{
  code: number;
  output: string;
}> {
  const saved = new Map(KEEPER_KEYS.map((key) => [key, process.env[key]]));
  const written: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    const text = String(chunk);
    if (text.startsWith("ts=")) {
      written.push(text);
      return true;
    }
    return (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try {
    for (const key of KEEPER_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    return {code: await main(), output: written.join("")};
  } finally {
    process.stdout.write = realWrite;
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("an empty environment is a refusal line and exit code 1, not a stack trace (F7)", async () => {
  // `loadConfig` used to run before the `try`, so the commonest operator mistake there is - a unit file that
  // is one variable short - left the process through an uncaught rejection: no `refused_to_start` line, and
  // nothing for `journalctl -u luckydraw-keeper -g refused_to_start` to find.
  const {code, output} = await runMain({});
  assert.strictEqual(code, 1);
  assert.ok(output.includes("event=refused_to_start"), `no refusal was logged: ${output}`);
  assert.ok(output.includes("level=error"), "the refusal is an error line");
  assert.ok(
    /KEEPER_UNLOCKED_ADDRESS/.test(output),
    `the reason names the variables the operator has to set: ${output}`,
  );
});

test("a configuration value is never echoed by the refusal that rejected it (F7)", async () => {
  const key = `0x${"11".repeat(32)}`;
  const {code, output} = await runMain({
    KEEPER_RPC_URL: "http://127.0.0.1:8545",
    KEEPER_CHAIN_ID: "31337",
    KEEPER_DRAW_ADDRESS: DRAW,
    KEEPER_UNLOCKED_ADDRESS: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    KEEPER_HEARTBEAT_URL: "https://monitor.example/ping/abc",
    // The shape this is actually about: a key that landed one `export` line short of its own variable.
    KEEPER_HEARTBEAT_METHOD: key,
  });
  assert.strictEqual(code, 1);
  assert.ok(output.includes("event=refused_to_start"));
  assert.ok(!output.toLowerCase().includes("1111"), `the value was echoed: ${output}`);
  assert.ok(output.includes("received 66 characters"), `the length is still reported: ${output}`);
});

test("a provider error carrying the RPC URL never reaches a log line", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(500, {"content-type": "text/plain"});
    response.end("upstream failure");
  });
  await new Promise<void>((resolve) => void server.listen(0, "127.0.0.1", resolve));
  const {port} = server.address() as AddressInfo;
  const secretPath = "v1/0123456789abcdefsecret";
  const url = `http://127.0.0.1:${port}/${secretPath}`;

  let result: {code: number; output: string};
  try {
    result = await runMain({
      KEEPER_RPC_URL: url,
      KEEPER_CHAIN_ID: "31337",
      KEEPER_DRAW_ADDRESS: DRAW,
      KEEPER_UNLOCKED_ADDRESS: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    });
  } finally {
    await new Promise<void>((resolve) => void server.close(() => resolve()));
  }

  assert.strictEqual(result.code, 1, "an unreachable node is a refusal to start");
  assert.ok(result.output.includes("event=refused_to_start"), `no refusal was logged: ${result.output}`);
  assert.ok(!/https?:\/\//.test(result.output), `a URL reached the log: ${result.output}`);
  assert.ok(!result.output.includes(secretPath), "the credential in the URL path must not be logged");
  assert.ok(result.output.includes("<rpc>"), "the URL is replaced, not silently dropped");
});

test("redaction leaves everything but the URL readable", () => {
  const message =
    'server response 500 (info={ "requestUrl": "https://bsc.example.com/v1/KEY" }, code=SERVER_ERROR)';
  const redacted = redactUrls(message);
  assert.ok(redacted.includes("server response 500"), "the operator still sees what happened");
  assert.ok(redacted.includes("code=SERVER_ERROR"));
  assert.ok(!redacted.includes("KEY"));
  assert.strictEqual(redactUrls("no url here"), "no url here");
  assert.strictEqual(formatValue("http://127.0.0.1:8545"), '"<rpc>"');
});
