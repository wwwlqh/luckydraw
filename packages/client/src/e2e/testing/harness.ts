// Process harness for the opt-in anvil end-to-end test.
//
// Excluded from the published build by tsconfig.build.json ("src/**/testing/**"). It starts a throwaway anvil
// on a free port and runs the repository's own deployment scripts against it, exactly as
// `scripts/test_deployment_live.py` does: `forge script ... --broadcast --unlocked --sender <anvil account 0>`,
// with `LUCKYDRAW_DEPLOYMENTS_DIR` pointing inside `contracts/test/script/tmp` because Foundry's
// `fs_permissions` allow writes only there and under `config/deployments`. No private key exists anywhere in
// this file: anvil's default accounts are unlocked, so the node signs.

import {type ChildProcess, spawn} from "node:child_process";
import {closeSync, existsSync, mkdirSync, openSync, readdirSync, writeFileSync} from "node:fs";
import {createServer} from "node:net";
import {homedir} from "node:os";
import {join} from "node:path";

/** anvil's first default account: the deploying operator in the local profile. */
export const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** Repository root, four levels above `packages/client/src/e2e/testing`. */
export const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
export const CONTRACTS_DIR = join(REPO_ROOT, "contracts");

/** Resolves a Foundry executable, preferring the pinned install over whatever is on PATH. */
export function foundryBin(name: string): string {
  const base = join(homedir(), ".foundry", "bin");
  for (const candidate of [join(base, `${name}.exe`), join(base, name)]) {
    if (existsSync(candidate)) return candidate;
  }
  return name;
}

/** A TCP port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("could not determine a free port")));
        return;
      }
      const {port} = address;
      server.close(() => resolve(port));
    });
  });
}

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
  });
  const body = (await response.json()) as {result?: unknown; error?: unknown};
  if (body.error !== undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

export type AnvilNode = {
  url: string;
  port: number;
  stop(): void;
};

/** Starts `anvil --host 127.0.0.1 --port <free> --chain-id 31337 --silent` and waits for it to answer. */
export async function startAnvil(logDir: string): Promise<AnvilNode> {
  mkdirSync(logDir, {recursive: true});
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const logFd = openSync(join(logDir, "anvil.log"), "w");
  let child: ChildProcess | null = spawn(
    foundryBin("anvil"),
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"],
    {cwd: REPO_ROOT, stdio: ["ignore", logFd, logFd], windowsHide: true},
  );

  const stop = (): void => {
    if (child !== null) {
      child.kill();
      child = null;
    }
    try {
      closeSync(logFd);
    } catch {
      // Already closed; the node is going away either way.
    }
  };

  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child === null || child.exitCode !== null) throw new Error("anvil exited before it was ready");
      try {
        if ((await rpc(url, "eth_chainId", [])) === "0x7a69") return {url, port, stop};
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`anvil did not start on ${url}`);
  } catch (error) {
    stop();
    throw error;
  }
}

export type ForgeRun = {
  /** Script contract name, e.g. `DeployLocal`; the file is `script/<name>.s.sol`. */
  name: string;
  /** Extra arguments after `--rpc-url <url>`. */
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  rpcUrl: string;
  /** Where the combined output is written. */
  logPath: string;
};

/** Runs one `forge script` from `contracts/`, throwing with the tail of its output on failure. */
export function runForgeScript(run: ForgeRun): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      foundryBin("forge"),
      ["script", `script/${run.name}.s.sol:${run.name}`, "--rpc-url", run.rpcUrl, ...run.args],
      {
        cwd: CONTRACTS_DIR,
        env: {...process.env, ...run.env},
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        // A debugging artifact under the run's own tmp directory, not a checked document.
        writeFileSync(run.logPath, output, "utf8");
      } catch {
        // A missing log must not mask the real failure below.
      }
      if (code === 0) resolve();
      else reject(new Error(`forge script ${run.name} exited ${code}:\n${output.slice(-4000)}`));
    });
  });
}

/** The single manifest `DeployLocal` wrote under `<dir>/31337/`. */
export function findManifest(deploymentsDir: string): string {
  const chainDir = join(deploymentsDir, "31337");
  const entries = readdirSync(chainDir).filter((name) => name.startsWith("0x") && name.endsWith(".json"));
  const first = entries[0];
  if (entries.length !== 1 || first === undefined) {
    throw new Error(`expected exactly one manifest in ${chainDir}, found ${entries.length}`);
  }
  return join(chainDir, first);
}
