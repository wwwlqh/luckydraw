// Environment configuration: the two signing modes are mutually exclusive, and nothing defaults silently
// into sending.

import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {
  ConfigError,
  chainRecordPathOf,
  DEFAULT_INTERVAL_MS,
  DEFAULT_LOG_WINDOW,
  type Environment,
  findRepoRoot,
  loadConfig,
  manifestPathOf,
  REPO_ROOT,
} from "./config.ts";

const DRAW = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const UNLOCKED = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const KEY = `0x${"11".repeat(32)}`;

function env(overrides: Environment = {}): Environment {
  return {
    KEEPER_RPC_URL: "http://127.0.0.1:8545",
    KEEPER_CHAIN_ID: "31337",
    KEEPER_DRAW_ADDRESS: DRAW,
    KEEPER_UNLOCKED_ADDRESS: UNLOCKED,
    ...overrides,
  };
}

test("defaults: 15 s cycles, a 2,000-block log window and no dry run", () => {
  const config = loadConfig(env());
  assert.strictEqual(config.intervalMs, DEFAULT_INTERVAL_MS);
  assert.strictEqual(config.logWindow, DEFAULT_LOG_WINDOW);
  assert.strictEqual(config.dryRun, false);
  assert.deepStrictEqual(config.signing, {kind: "unlocked", address: UNLOCKED});
  assert.strictEqual(config.chainId, 31337n);
});

test("the manifest path is <deployments>/<chainId>/<lowercase draw address>.json", () => {
  const config = loadConfig(env());
  assert.strictEqual(
    manifestPathOf(config),
    join(REPO_ROOT, "config", "deployments", "31337", `${DRAW}.json`),
  );
});

test("the repository root is found by the workspace marker, from src and from dist alike", () => {
  // `keeper/src` and the built `keeper/dist/keeper/src` are different distances from the root, which is why
  // this walks up to `pnpm-workspace.yaml` instead of counting levels. The hardened unit runs the built file.
  assert.strictEqual(REPO_ROOT, findRepoRoot(import.meta.dirname));
  assert.ok(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml")));
  assert.strictEqual(findRepoRoot(join(REPO_ROOT, "keeper", "dist", "keeper", "src")), REPO_ROOT);
  assert.strictEqual(findRepoRoot(REPO_ROOT), REPO_ROOT);
  // No marker anywhere above: the old two-levels-up behaviour, so a lone `dist/` tree still resolves to
  // *something* and the operator overrides it with KEEPER_DEPLOYMENTS_DIR.
  const orphan = join(tmpdir(), "luckydraw-no-workspace", "a", "b");
  assert.strictEqual(findRepoRoot(orphan), join(tmpdir(), "luckydraw-no-workspace"));
});

test("both signing modes at once is refused", () => {
  assert.throws(
    () => loadConfig(env({KEEPER_PRIVATE_KEY: KEY})),
    (error: unknown) =>
      error instanceof ConfigError &&
      /mutually exclusive/.test(error.message) &&
      !error.message.includes(KEY),
  );
});

test("neither signing mode is refused", () => {
  assert.throws(
    () => loadConfig(env({KEEPER_UNLOCKED_ADDRESS: undefined})),
    (error: unknown) => error instanceof ConfigError && /exactly one/.test(error.message),
  );
});

test("the private-key mode records the mode and never the key", () => {
  const config = loadConfig(env({KEEPER_UNLOCKED_ADDRESS: undefined, KEEPER_PRIVATE_KEY: KEY}));
  assert.deepStrictEqual(config.signing, {kind: "privateKey", source: "environment"});
  const serialised = JSON.stringify(config, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  assert.ok(!serialised.includes(KEY), "no serialisation of the config can leak the key");
});

test("an empty variable counts as absent, not as a mode", () => {
  assert.throws(
    () => loadConfig(env({KEEPER_UNLOCKED_ADDRESS: "   "})),
    (error: unknown) => error instanceof ConfigError && /exactly one/.test(error.message),
  );
});

test("a key pasted into an address variable is never echoed back (F4)", () => {
  // The three variables sit next to each other in every command in the README, and `main` prints a
  // `ConfigError`'s message as `refused_to_start` - to a terminal, and often to a file.
  for (const name of ["KEEPER_UNLOCKED_ADDRESS", "KEEPER_DRAW_ADDRESS"]) {
    assert.throws(
      () => loadConfig(env({KEEPER_UNLOCKED_ADDRESS: UNLOCKED, [name]: KEY})),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.message.includes(name) &&
        error.message.includes("66 characters") &&
        !error.message.includes(KEY) &&
        !error.message.includes(KEY.slice(2, 10)),
      `${name} must not echo its value`,
    );
  }
});

test("KEEPER_DRAW_ADDRESS must be lowercase, because it names the manifest file", () => {
  assert.throws(
    () => loadConfig(env({KEEPER_DRAW_ADDRESS: "0x610178DA211FEF7D417BC0E6FED39F05609AD788"})),
    ConfigError,
  );
  assert.throws(() => loadConfig(env({KEEPER_DRAW_ADDRESS: "not-an-address"})), ConfigError);
});

test("KEEPER_RPC_URL and KEEPER_CHAIN_ID are required and validated", () => {
  assert.throws(() => loadConfig(env({KEEPER_RPC_URL: undefined})), ConfigError);
  assert.throws(() => loadConfig(env({KEEPER_CHAIN_ID: undefined})), ConfigError);
  assert.throws(() => loadConfig(env({KEEPER_CHAIN_ID: "0"})), ConfigError);
  assert.throws(() => loadConfig(env({KEEPER_CHAIN_ID: "-1"})), ConfigError);
  assert.throws(() => loadConfig(env({KEEPER_CHAIN_ID: "97.5"})), ConfigError);
});

test("KEEPER_INTERVAL_MS and KEEPER_LOG_WINDOW are positive integers", () => {
  const config = loadConfig(env({KEEPER_INTERVAL_MS: "500", KEEPER_LOG_WINDOW: "1000"}));
  assert.strictEqual(config.intervalMs, 500);
  assert.strictEqual(config.logWindow, 1_000n);
  assert.throws(() => loadConfig(env({KEEPER_INTERVAL_MS: "0"})), ConfigError);
  assert.throws(() => loadConfig(env({KEEPER_LOG_WINDOW: "abc"})), ConfigError);
});

test("KEEPER_DRY_RUN is on only for the exact value 1", () => {
  assert.strictEqual(loadConfig(env({KEEPER_DRY_RUN: "1"})).dryRun, true);
  assert.strictEqual(loadConfig(env({KEEPER_DRY_RUN: "true"})).dryRun, false);
  assert.strictEqual(loadConfig(env({KEEPER_DRY_RUN: "0"})).dryRun, false);
});

test("the chain record path is <chains>/<chainId>.json", () => {
  assert.strictEqual(chainRecordPathOf(loadConfig(env())), join(REPO_ROOT, "config", "chains", "31337.json"));
  assert.strictEqual(
    chainRecordPathOf(loadConfig(env({KEEPER_CHAINS_DIR: "/srv/chains"}))),
    join("/srv/chains", "31337.json"),
  );
});

test("both notification signals are off unless their variable is set (SPEC 14)", () => {
  const config = loadConfig(env());
  assert.strictEqual(config.heartbeat, null);
  assert.strictEqual(config.alertWebhook, null);
  assert.strictEqual(loadConfig(env({KEEPER_HEARTBEAT_URL: "  "})).heartbeat, null);
  assert.strictEqual(loadConfig(env({KEEPER_ALERT_WEBHOOK: ""})).alertWebhook, null);
});

test("a heartbeat defaults to GET and accepts POST, in any case", () => {
  const url = "https://monitor.example/ping/abc";
  assert.deepStrictEqual(loadConfig(env({KEEPER_HEARTBEAT_URL: url})).heartbeat, {url, method: "GET"});
  assert.deepStrictEqual(
    loadConfig(env({KEEPER_HEARTBEAT_URL: url, KEEPER_HEARTBEAT_METHOD: "post"})).heartbeat,
    {url, method: "POST"},
  );
  assert.throws(
    () => loadConfig(env({KEEPER_HEARTBEAT_URL: url, KEEPER_HEARTBEAT_METHOD: "PUT"})),
    (error: unknown) => error instanceof ConfigError && /GET or POST/.test(error.message),
  );
  // The refusal never echoes the value (F7): this variable sits next to KEEPER_PRIVATE_KEY in the README
  // commands, so a line that lands one variable short puts a key here and `main` prints the message.
  const key = `0x${"11".repeat(32)}`;
  assert.throws(
    () => loadConfig(env({KEEPER_HEARTBEAT_URL: url, KEEPER_HEARTBEAT_METHOD: key})),
    (error: unknown) =>
      error instanceof ConfigError &&
      !error.message.includes(key) &&
      !error.message.toLowerCase().includes("1111") &&
      /received 66 characters/.test(error.message),
  );
  // The method alone arms nothing: without the URL there is no heartbeat to send.
  assert.strictEqual(loadConfig(env({KEEPER_HEARTBEAT_METHOD: "POST"})).heartbeat, null);
});

test("a notification URL must be absolute http(s), and is never echoed when it is not (F4)", () => {
  // Both are bearer credentials: the token is the path. A rejection says how long the value was.
  const secret = "monitor.example/ping/0000-secret-token";
  for (const name of ["KEEPER_HEARTBEAT_URL", "KEEPER_ALERT_WEBHOOK"]) {
    for (const value of [secret, `ftp://${secret}`, `file:///${secret}`]) {
      assert.throws(
        () => loadConfig(env({[name]: value})),
        (error: unknown) =>
          error instanceof ConfigError &&
          error.message.includes(name) &&
          error.message.includes(`${value.length} characters`) &&
          !error.message.includes("secret-token"),
        `${name}=${value} must be refused without echoing it`,
      );
    }
  }
});
