// Where the signing key comes from when systemd starts the keeper (SPEC §10.5, §12).
//
// Under the unit in `keeper/deploy/`, `LoadCredential=keeper-private-key:/etc/luckydraw/keeper-private-key`
// makes systemd copy a root-owned 0600 file into a per-invocation tmpfs and export the directory holding it
// as `CREDENTIALS_DIRECTORY`. The key therefore never appears in a process argument, in a shell rc file, in
// `EnvironmentFile=` (which is world-readable to anyone who can read the unit's environment through
// `/proc/<pid>/environ`), or in `systemctl show`. `KEEPER_PRIVATE_KEY` stays supported for an operator
// running the keeper from their own shell, and is the fallback when no credential was passed.
//
// Nothing here is ever logged. `privateKeySource` answers *whether* a key is available, and from where,
// without reading it; `readPrivateKey` is called exactly once, by `createSender`, and its return value is
// handed straight to `new Wallet(...)`.

import {existsSync, readFileSync} from "node:fs";
import {isAbsolute, join} from "node:path";
import type {Environment} from "./config.ts";

/** The credential name the unit file uses; also the basename systemd gives it inside the directory. */
export const PRIVATE_KEY_CREDENTIAL = "keeper-private-key";

/** Which of the two supported places held the key. Recorded in the configuration and logged; the value is not. */
export type KeySource = "credential" | "environment";

export type CredentialIo = {
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
};

/**
 * The path systemd would have put the key at, or null.
 *
 * `CREDENTIALS_DIRECTORY` is set for *any* `LoadCredential=`, so its presence is not proof that this
 * particular credential was passed; the file's existence is. A relative value is ignored rather than
 * resolved against the working directory, because systemd always exports an absolute path and anything else
 * is an environment somebody else built.
 */
export function credentialPath(env: Environment, name: string = PRIVATE_KEY_CREDENTIAL): string | null {
  const directory = env.CREDENTIALS_DIRECTORY?.trim();
  if (directory === undefined || directory === "" || !isAbsolute(directory)) return null;
  return join(directory, name);
}

/** Whether a key is available and from where, without reading a single byte of it. */
export function privateKeySource(env: Environment, io: CredentialIo = {}): KeySource | null {
  const exists = io.exists ?? existsSync;
  const path = credentialPath(env);
  if (path !== null && exists(path)) return "credential";
  const fromEnv = env.KEEPER_PRIVATE_KEY?.trim();
  return fromEnv === undefined || fromEnv === "" ? null : "environment";
}

/**
 * The key itself, from the credential when systemd passed one and from the environment otherwise.
 *
 * The credential wins: an operator who has installed the unit and also has a stale `KEEPER_PRIVATE_KEY`
 * exported in a shell must sign with the key the unit was given, not with whichever one happens to be in the
 * environment. Which source was used is in the `started` log line as `keySource`; the key is not.
 *
 * A credential file is trimmed, because `printf` into a file and an editor both leave a trailing newline and
 * ethers rejects a key with one.
 */
export function readPrivateKey(env: Environment, io: CredentialIo = {}): string | null {
  const exists = io.exists ?? existsSync;
  const readFile = io.readFile ?? ((path: string): string => readFileSync(path, "utf8"));
  const path = credentialPath(env);
  if (path !== null && exists(path)) {
    const raw = readFile(path).trim();
    return raw === "" ? null : raw;
  }
  const fromEnv = env.KEEPER_PRIVATE_KEY?.trim();
  return fromEnv === undefined || fromEnv === "" ? null : fromEnv;
}
