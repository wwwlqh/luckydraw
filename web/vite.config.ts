// Vite and vitest configuration for `@luckydraw/web` (SPEC §9.3, §9.6, §12).
//
// Three things here are not defaults and are load-bearing:
//
//  1. `@luckydraw/client` resolves to the package's TypeScript sources, not its `dist/`. The root CI runs
//     `pnpm typecheck` and `pnpm test` before `pnpm build`, so the web app must compile and test with the
//     client unbuilt. `tsconfig.json` carries the same mapping in `paths`.
//  2. The deployment the build is pinned to is checked on disk in `buildStart`, so a missing or misspelled
//     `VITE_LUCKYDRAW_CHAIN_ID` / `VITE_LUCKYDRAW_DRAW_ADDRESS` fails the build loudly rather than shipping
//     a page that throws at start-up (SPEC §15: validate manifest chain/address agreement before any UI signs).
//  3. The Content-Security-Policy meta tag is written with the configured RPC origins substituted in, so
//     `connect-src` is limited to the RPCs this build actually talks to (SPEC §9.6).
//  4. `base` comes from `VITE_LUCKYDRAW_BASE`, because a GitHub Pages project site is served under
//     `/<repo>/` rather than at the root of its origin. Vite republishes the resolved value as
//     `import.meta.env.BASE_URL`, which `app/App.tsx` hands to `BrowserRouter` as its `basename`, so the
//     prefix is configured in exactly one place and the asset URLs and the routes cannot disagree.
//  5. A chain 56 build passes the mainnet release gate of `src/lib/build/releaseGate.ts` and the repository's
//     own `scripts/validate_config.ts` before a single file is emitted (SPEC §14, ADR 034). The decision
//     itself is a pure function over the parsed manifest so every branch of it is unit-tested; this file only
//     reads the file, runs the validator and turns a refusal into a non-zero exit with one reason line.

import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import react from "@vitejs/plugin-react";
import {loadEnv} from "vite";
import {defineConfig, type Plugin} from "vitest/config";
import {
  checkFallbackPairing,
  checkReleaseGate,
  isMainnetBuild,
  REFUSAL_PREFIX,
  type ValueSource,
} from "./src/lib/build/releaseGate.ts";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const clientEntry = fileURLToPath(new URL("../packages/client/src/index.ts", import.meta.url));

/** The token `index.html` carries in its CSP meta tag, replaced with the resolved origins at transform time. */
const CSP_TOKEN = "%CSP_CONNECT_SRC%";

/** Repo-relative, POSIX-spelled, so a reason line reads the same on Windows and in CI. */
function manifestRelativePath(chainId: string, drawAddress: string): string {
  return `config/deployments/${chainId}/${drawAddress}.json`;
}

function manifestPath(chainId: string, drawAddress: string): string {
  return join(repoRoot, "config", "deployments", chainId, `${drawAddress}.json`);
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The `VITE_` variables this build reads. */
const ENV_KEYS = [
  "VITE_LUCKYDRAW_CHAIN_ID",
  "VITE_LUCKYDRAW_DRAW_ADDRESS",
  "VITE_LUCKYDRAW_RPC_URL",
  "VITE_LUCKYDRAW_BLOCK_POLL_MS",
  // The operator's jurisdiction sentence (SPEC §14). Required and non-empty on chain 56; empty elsewhere.
  // Plain text: every surface that renders it does so as a text node, never as markup.
  "VITE_LUCKYDRAW_JURISDICTION_NOTICE",
] as const;

/**
 * `.env.example` doubles as the committed default, so `pnpm build` works in a clean checkout and in CI
 * without a secret or a hand-written file: it names the local anvil mock deployment, and `.env` (untracked)
 * overrides it for a testnet build. Nothing here is a secret; RPC credentials never belong in a static build.
 */
function exampleEnv(): Record<string, string> {
  const file = join(webRoot, ".env.example");
  if (!existsSync(file)) return {};
  const parsed: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (match === null) continue;
    const [, key, value] = match as unknown as [string, string, string];
    parsed[key] = value.trim();
  }
  return parsed;
}

/**
 * The un-prefixed alias of a `VITE_LUCKYDRAW_*` key: `VITE_LUCKYDRAW_CHAIN_ID` -> `LUCKYDRAW_CHAIN_ID`.
 *
 * The Pages workflow, the runbooks and the operator's own shell all speak in `LUCKYDRAW_*` names — those are
 * what the repository variables are called — while Vite only ever sees a variable if it carries the `VITE_`
 * prefix. Accepting the alias is what makes `LUCKYDRAW_CHAIN_ID=56 pnpm build` mean chain 56 instead of
 * silently falling back to the committed local default, which is precisely the mistake the gate exists to
 * catch. The prefixed spelling still wins, and a disagreement between the two is refused rather than guessed.
 */
function aliasOf(key: string): string {
  return key.slice("VITE_".length);
}

type ResolvedEnv = {
  values: Record<string, string>;
  /** Where each value came from, so `checkFallbackPairing` can refuse a half-set configuration. */
  sources: Record<string, ValueSource>;
};

function resolveEnv(loaded: Record<string, string>): ResolvedEnv {
  const defaults = exampleEnv();
  const values: Record<string, string> = {};
  const sources: Record<string, ValueSource> = {};
  for (const key of ENV_KEYS) {
    const prefixed = (loaded[key] ?? "").trim();
    const alias = (process.env[aliasOf(key)] ?? "").trim();
    if (prefixed !== "" && alias !== "" && prefixed !== alias) {
      throw new Error(
        `${key} is ${JSON.stringify(prefixed)} but ${aliasOf(key)} is ${JSON.stringify(alias)}. ` +
          "Set one of them, not two that disagree.",
      );
    }
    const fromEnvironment = prefixed !== "" ? prefixed : alias;
    values[key] = fromEnvironment !== "" ? fromEnvironment : (defaults[key] ?? "");
    sources[key] = fromEnvironment !== "" ? "environment" : "fallback";
  }
  return {values, sources};
}

/**
 * The path this build is served under, always leading and trailing slash. `/` — the default — is a site at
 * the root of its own origin and is what every earlier build assumed; `/luckydraw/` is a GitHub Pages
 * project site. This is not a secret and is not part of `.env.example`'s deployment fallback: it describes
 * where the files live, not which deployment they read, so an unset value must mean "the root", never the
 * last operator's repository name.
 */
function resolveBase(loaded: Record<string, string>): string {
  const raw = (loaded.VITE_LUCKYDRAW_BASE ?? "").trim();
  if (raw === "") return "/";
  if (raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    // An origin here would put every asset URL on another host and silently move the app off its own CSP.
    throw new Error(
      `VITE_LUCKYDRAW_BASE must be a path such as /luckydraw/, not a URL; got ${JSON.stringify(raw)}.`,
    );
  }
  const leading = raw.startsWith("/") ? raw : `/${raw}`;
  return leading.endsWith("/") ? leading : `${leading}/`;
}

/**
 * Runs `node scripts/validate_config.ts` over the repository's configuration records, inheriting stdio so the
 * operator sees the validator's own per-document output. Returns null on success, a reason line on failure.
 *
 * The validator needs no network and reads no secret (see `config/README.md`), so running it from a build is
 * safe; it is run only for a mainnet build, because that is the only one where a stale or contradictory
 * record reaches a customer, and every other build keeps its current speed.
 */
function runConfigValidator(): string | null {
  try {
    execFileSync(process.execPath, [join(repoRoot, "scripts", "validate_config.ts")], {
      cwd: repoRoot,
      stdio: "inherit",
    });
    return null;
  } catch {
    return (
      `${REFUSAL_PREFIX} node scripts/validate_config.ts failed, so the configuration records this build ` +
      "would publish are not valid. Fix what it printed above and build again."
    );
  }
}

/**
 * Fails the build when the selected deployment manifest is absent, when the address is not lowercase, or
 * when the file on disk disagrees with the two environment variables that chose it — and, on chain 56, when
 * the deployment has not passed the SPEC §14 release gates.
 */
function releaseGuard(resolved: ResolvedEnv): Plugin {
  const env = resolved.values;
  return {
    name: "luckydraw:release-guard",
    apply: "build",
    buildStart() {
      const chainId = env.VITE_LUCKYDRAW_CHAIN_ID ?? "";
      const drawAddress = env.VITE_LUCKYDRAW_DRAW_ADDRESS ?? "";

      // First, before anything else is judged: the committed local fallback may not part-fill a build for
      // another chain. A chain 56 run of the Pages workflow with the Draw address variable forgotten would
      // otherwise publish a "mainnet" page pinned to the anvil contract and a 127.0.0.1 RPC.
      const pairing = checkFallbackPairing({
        chainIdText: chainId,
        chainIdSource: resolved.sources.VITE_LUCKYDRAW_CHAIN_ID ?? "fallback",
        drawAddressSource: resolved.sources.VITE_LUCKYDRAW_DRAW_ADDRESS ?? "fallback",
        rpcUrlSource: resolved.sources.VITE_LUCKYDRAW_RPC_URL ?? "fallback",
      });
      if (!pairing.ok) this.error(pairing.reason);

      if (chainId === "" || drawAddress === "") {
        this.error(
          "VITE_LUCKYDRAW_CHAIN_ID and VITE_LUCKYDRAW_DRAW_ADDRESS must both be set; see web/.env.example.",
        );
      }
      if (!/^0x[0-9a-f]{40}$/.test(drawAddress)) {
        this.error(
          `VITE_LUCKYDRAW_DRAW_ADDRESS must be a lowercase 0x address, got ${JSON.stringify(drawAddress)}.`,
        );
      }
      const file = manifestPath(chainId, drawAddress);
      const shown = manifestRelativePath(chainId, drawAddress);
      const mainnet = isMainnetBuild(chainId);

      // Read before anything is asserted, so the mainnet gate — which has its own words for "no manifest" —
      // answers first on chain 56 instead of the generic missing-file error below.
      let parsed: unknown = null;
      if (existsSync(file)) {
        try {
          parsed = JSON.parse(readFileSync(file, "utf8"));
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          this.error(
            mainnet ? `${REFUSAL_PREFIX} ${shown} is not valid JSON: ${detail}` : `${shown}: ${detail}`,
          );
        }
      }

      if (mainnet) {
        const verdict = checkReleaseGate({
          chainIdText: chainId,
          manifest: parsed,
          manifestPath: shown,
          jurisdictionNotice: env.VITE_LUCKYDRAW_JURISDICTION_NOTICE ?? "",
        });
        if (!verdict.ok) this.error(verdict.reason);
        const validatorFailure = runConfigValidator();
        if (validatorFailure !== null) this.error(validatorFailure);
      }

      if (!existsSync(file)) {
        this.error(`No deployment manifest at ${file} for chain ${chainId} and draw ${drawAddress}.`);
      }
      const expectedId = `${chainId}:${drawAddress}`;
      const declared = (parsed as {deploymentId?: unknown} | null)?.deploymentId;
      if (declared !== expectedId) {
        this.error(
          `${file} declares deploymentId ${String(declared)}, but the build selected ${expectedId}.`,
        );
      }
      if (!existsSync(join(repoRoot, "config", "chains", `${chainId}.json`))) {
        this.error(`No chain record at config/chains/${chainId}.json for the selected deployment.`);
      }
    },
  };
}

/**
 * Substitutes the CSP token in `index.html`. `connect-src` gets `'self'` plus the origin of every configured
 * RPC URL; everything else stays on `'self'`, and scripts never get `'unsafe-inline'`.
 */
function cspPlugin(env: Record<string, string>): Plugin {
  const origins = new Set<string>();
  for (const url of (env.VITE_LUCKYDRAW_RPC_URL ?? "").split(/[\s,]+/).filter(Boolean)) {
    const origin = originOf(url);
    if (origin !== null) origins.add(origin);
  }
  const connectSrc = ["'self'", ...origins].join(" ");
  return {
    name: "luckydraw:csp",
    transformIndexHtml: {
      order: "post",
      handler: (html) => html.split(CSP_TOKEN).join(connectSrc),
    },
  };
}

export default defineConfig(({mode}) => {
  const loaded = loadEnv(mode, webRoot, "VITE_");
  const resolved = resolveEnv(loaded);
  const env = resolved.values;
  // The resolved values are substituted directly, so `import.meta.env` carries the `.env.example` defaults
  // as well as anything an untracked `.env` overrode.
  const define: Record<string, string> = {};
  for (const key of ENV_KEYS) define[`import.meta.env.${key}`] = JSON.stringify(env[key] ?? "");
  return {
    root: webRoot,
    base: resolveBase(loaded),
    plugins: [react(), releaseGuard(resolved), cspPlugin(env)],
    define,
    resolve: {
      alias: [{find: /^@luckydraw\/client$/, replacement: clientEntry}],
    },
    server: {
      // `config/` sits outside the Vite root; the manifest and chain records are imported from there.
      fs: {allow: [repoRoot]},
    },
    build: {
      target: "es2023",
      // No inline module-preload polyfill: the CSP forbids inline scripts (SPEC §9.6).
      modulePreload: {polyfill: false},
      sourcemap: false,
      rollupOptions: {
        output: {
          // ethers is the single large dependency; splitting it keeps the `/` entry chunk small and lets the
          // browser cache it across deploys (SPEC §9.3 performance budget).
          manualChunks: (id: string) => (id.includes("node_modules/ethers") ? "ethers" : undefined),
        },
      },
    },
    test: {
      environment: "jsdom",
      globals: false,
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      restoreMocks: true,
    },
  };
});
