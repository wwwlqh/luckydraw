// Where the key comes from under systemd, and what happens when it is in two places at once.
//
// Real files in a real temporary directory rather than a fake filesystem: what is under test is precisely
// the interaction with the directory systemd creates, so faking the thing being asserted would prove
// nothing. Every key in this file is the obviously-fake `0x1111...`.

import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {ConfigError, loadConfig} from "./config.ts";
import {credentialPath, PRIVATE_KEY_CREDENTIAL, privateKeySource, readPrivateKey} from "./credentials.ts";

const DRAW = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const CREDENTIAL_KEY = `0x${"11".repeat(32)}`;
const ENV_KEY = `0x${"22".repeat(32)}`;

/** A directory shaped like the one systemd exports as `CREDENTIALS_DIRECTORY`. */
function credentialsDir(contents: string | null): string {
  const directory = mkdtempSync(join(tmpdir(), "luckydraw-creds-"));
  if (contents !== null) writeFileSync(join(directory, PRIVATE_KEY_CREDENTIAL), contents, "utf8");
  return directory;
}

test("the credential path is <CREDENTIALS_DIRECTORY>/keeper-private-key, and nothing else is", () => {
  assert.strictEqual(
    credentialPath({CREDENTIALS_DIRECTORY: "/run/creds"}),
    join("/run/creds", "keeper-private-key"),
  );
  assert.strictEqual(credentialPath({}), null);
  assert.strictEqual(credentialPath({CREDENTIALS_DIRECTORY: "  "}), null);
  // systemd always exports an absolute path; a relative one is somebody else's environment and is ignored
  // rather than resolved against whatever the working directory happens to be.
  assert.strictEqual(credentialPath({CREDENTIALS_DIRECTORY: "relative/creds"}), null);
});

test("a systemd credential is found and read, trailing newline and all", (t) => {
  const directory = credentialsDir(`${CREDENTIAL_KEY}\n`);
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const env = {CREDENTIALS_DIRECTORY: directory};
  assert.strictEqual(privateKeySource(env), "credential");
  assert.strictEqual(readPrivateKey(env), CREDENTIAL_KEY);
});

test("the credential wins over a stale KEEPER_PRIVATE_KEY in the environment", (t) => {
  const directory = credentialsDir(CREDENTIAL_KEY);
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const env = {CREDENTIALS_DIRECTORY: directory, KEEPER_PRIVATE_KEY: ENV_KEY};
  assert.strictEqual(privateKeySource(env), "credential");
  assert.strictEqual(readPrivateKey(env), CREDENTIAL_KEY, "the unit's key signs, not the shell's");
});

test("CREDENTIALS_DIRECTORY without this credential falls back to the environment", (t) => {
  // systemd sets the directory for *any* LoadCredential=, so its presence is not proof this one was passed.
  const directory = credentialsDir(null);
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const env = {CREDENTIALS_DIRECTORY: directory, KEEPER_PRIVATE_KEY: ENV_KEY};
  assert.strictEqual(privateKeySource(env), "environment");
  assert.strictEqual(readPrivateKey(env), ENV_KEY);
});

test("no credential and no variable is no key at all", () => {
  assert.strictEqual(privateKeySource({}), null);
  assert.strictEqual(readPrivateKey({}), null);
  assert.strictEqual(privateKeySource({KEEPER_PRIVATE_KEY: "   "}), null);
});

test("an empty credential file is a refusal, never a silent fallback", (t) => {
  const directory = credentialsDir("\n");
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const env = {CREDENTIALS_DIRECTORY: directory, KEEPER_PRIVATE_KEY: ENV_KEY};
  // The file exists, so the credential is what was meant; an empty one is a broken install, and signing
  // with whatever is in the environment instead would sign from an account nobody chose.
  assert.strictEqual(readPrivateKey(env), null);
});

test("a credential selects the private-key signing mode without the variable being set", (t) => {
  const directory = credentialsDir(CREDENTIAL_KEY);
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const config = loadConfig({
    KEEPER_RPC_URL: "http://127.0.0.1:8545",
    KEEPER_CHAIN_ID: "56",
    KEEPER_DRAW_ADDRESS: DRAW,
    CREDENTIALS_DIRECTORY: directory,
  });
  assert.deepStrictEqual(config.signing, {kind: "privateKey", source: "credential"});
  const serialised = JSON.stringify(config, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  assert.ok(!serialised.includes(CREDENTIAL_KEY), "no serialisation of the config can leak the key");
});

test("a credential and KEEPER_UNLOCKED_ADDRESS are still mutually exclusive", (t) => {
  const directory = credentialsDir(CREDENTIAL_KEY);
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  assert.throws(
    () =>
      loadConfig({
        KEEPER_RPC_URL: "http://127.0.0.1:8545",
        KEEPER_CHAIN_ID: "31337",
        KEEPER_DRAW_ADDRESS: DRAW,
        KEEPER_UNLOCKED_ADDRESS: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        CREDENTIALS_DIRECTORY: directory,
      }),
    (error: unknown) => error instanceof ConfigError && /mutually exclusive/.test(error.message),
  );
});
