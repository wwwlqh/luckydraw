// Start-up refusals: the chain id, the environment and the manifest identity.
//
// The manifest read here is the repository's own local record, so a change to the manifest schema breaks
// these tests rather than passing silently.

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import test from "node:test";
import {keccak256} from "ethers";
import {
  drawInterface,
  fakeProvider,
  type RecordedCall,
  vaultInterface,
} from "../../packages/client/src/reads/testing/fake.ts";
import {parseManifest, verifyDeployment} from "./client.ts";
import {ConfigError, type Environment, loadConfig, REPO_ROOT} from "./config.ts";
import {
  assertChainId,
  assertNoMocks,
  assertSigningAllowed,
  BSC_MAINNET_CHAIN_ID,
  loadManifest,
  loadMulticall3,
  prepare,
  StartupError,
  type StartupProvider,
  withNodeChainId,
} from "./startup.ts";

const DRAW = "0x610178da211fef7d417bc0e6fed39f05609ad788";
const UNLOCKED = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const KEY = `0x${"11".repeat(32)}`;
const MANIFEST_PATH = join(REPO_ROOT, "config", "deployments", "31337", `${DRAW}.json`);
const MANIFEST_JSON = readFileSync(MANIFEST_PATH, "utf8");

function env(overrides: Environment = {}): Environment {
  return {
    KEEPER_RPC_URL: "http://127.0.0.1:8545",
    KEEPER_CHAIN_ID: "31337",
    KEEPER_DRAW_ADDRESS: DRAW,
    KEEPER_UNLOCKED_ADDRESS: UNLOCKED,
    ...overrides,
  };
}

const readFixture = (): string => MANIFEST_JSON;

/**
 * The two block reads of `ReadProvider`, refusing.
 *
 * Only the Multicall3 gate resolves a snapshot block, and it runs after every refusal below; a fake that
 * throws here therefore asserts the order of the gates as well as satisfying the type.
 */
function noSnapshot(why: string): Pick<StartupProvider, "getBlock" | "getBlockNumber"> {
  return {
    async getBlock(): Promise<never> {
      throw new Error(why);
    },
    async getBlockNumber(): Promise<never> {
      throw new Error(why);
    },
  };
}

/**
 * A node that answers one chain id and nothing else; the refusals below never get past the chain-id gate.
 *
 * `getNetwork` answers the *configured* chain id, exactly as ethers does under `staticNetwork: true`, and
 * `send("eth_chainId")` answers the node's. They agree here; `chainIdDouble` below is where they differ.
 */
function nodeOn(chainId: bigint): StartupProvider {
  return {
    ...noSnapshot("verification must not resolve a block in these cases"),
    async getNetwork() {
      return {chainId};
    },
    async send(method: string) {
      if (method !== "eth_chainId") throw new Error(`unexpected request ${method}`);
      return `0x${chainId.toString(16)}`;
    },
    async getCode() {
      throw new Error("verification must not reach getCode in these cases");
    },
    async call() {
      throw new Error("verification must not reach call in these cases");
    },
  };
}

/**
 * The provider `main.ts` actually builds: `staticNetwork: true`, so `getNetwork` is configuration and only a
 * raw `eth_chainId` is the node (F1). Here configuration says 31337 and the node is BSC mainnet.
 */
function chainIdDouble(): StartupProvider {
  return {
    ...noSnapshot("the chain-id gate must not resolve a block"),
    async getNetwork() {
      return {chainId: 31337n}; // What KEEPER_CHAIN_ID said, echoed back without a request.
    },
    async send(method: string) {
      if (method !== "eth_chainId") throw new Error(`unexpected request ${method}`);
      return "0x38";
    },
    async getCode() {
      throw new Error("verification must not reach getCode when the chain id is wrong");
    },
    async call() {
      throw new Error("verification must not reach call when the chain id is wrong");
    },
  };
}

test("the manifest must be the one the environment named", () => {
  const wrongChain = loadConfig(env({KEEPER_CHAIN_ID: "97"}));
  assert.throws(
    () => loadManifest(wrongChain, readFixture),
    (error: unknown) => error instanceof StartupError && /records chain 31337/.test(error.message),
  );
  const wrongDraw = loadConfig(env({KEEPER_DRAW_ADDRESS: `0x${"0".repeat(39)}1`}));
  assert.throws(
    () => loadManifest(wrongDraw, readFixture),
    (error: unknown) => error instanceof StartupError && /KEEPER_DRAW_ADDRESS/.test(error.message),
  );
});

test("a missing manifest is a refusal, not an empty configuration", () => {
  const config = loadConfig(env({KEEPER_DEPLOYMENTS_DIR: join(REPO_ROOT, "no", "such", "tree")}));
  assert.throws(() => loadManifest(config), StartupError);
});

test("a private key is refused against a local deployment", () => {
  const config = loadConfig(env({KEEPER_UNLOCKED_ADDRESS: undefined, KEEPER_PRIVATE_KEY: KEY}));
  const manifest = loadManifest(config, readFixture);
  assert.strictEqual(manifest.environment, "local");
  assert.throws(
    () => assertSigningAllowed(config, manifest),
    (error: unknown) =>
      error instanceof StartupError &&
      /must not be used against a local deployment/.test(error.message) &&
      !error.message.includes(KEY),
  );
});

test("the unlocked mode is allowed against the same local deployment", () => {
  const config = loadConfig(env());
  assert.doesNotThrow(() => assertSigningAllowed(config, loadManifest(config, readFixture)));
});

test("a chain id that differs from the manifest halts start-up (SPEC 12)", async () => {
  const config = loadConfig(env());
  const manifest = loadManifest(config, readFixture);
  await assert.rejects(
    () => assertChainId(config, nodeOn(97n), manifest),
    (error: unknown) =>
      error instanceof StartupError &&
      /node reports chain 97 .* manifest is for chain 31337/.test(error.message),
  );
  await assert.doesNotReject(() => assertChainId(config, nodeOn(31337n), manifest));
});

test("an unreachable node is a refusal with the node's own message", async () => {
  const config = loadConfig(env());
  const manifest = loadManifest(config, readFixture);
  const dead: StartupProvider = {
    ...noSnapshot("an unreachable node is refused before any block is read"),
    async getNetwork(): Promise<{chainId: bigint}> {
      return {chainId: 31337n};
    },
    async send(): Promise<unknown> {
      throw new Error("ECONNREFUSED");
    },
    async getCode() {
      return "0x";
    },
    async call() {
      return "0x";
    },
  };
  await assert.rejects(
    () => assertChainId(config, dead, manifest),
    (error: unknown) => error instanceof StartupError && /ECONNREFUSED/.test(error.message),
  );
});

test("the chain-id gate asks the node, not the static network it was configured with (F1)", async () => {
  const config = loadConfig(env());
  const manifest = loadManifest(config, readFixture);
  // `getNetwork` agrees with the manifest; the node is on another chain entirely.
  await assert.rejects(
    () => assertChainId(config, chainIdDouble(), manifest),
    (error: unknown) =>
      error instanceof StartupError &&
      /node reports chain 56 .* manifest is for chain 31337/.test(error.message),
  );
  // And `prepare` refuses before it reaches verification, which is what `getCode` here asserts.
  await assert.rejects(
    () => prepare(config, chainIdDouble(), readFixture),
    (error: unknown) => error instanceof StartupError && /node reports chain 56/.test(error.message),
  );
});

test("verifyDeployment is given the node's chain id too, so its own check is not self-confirming (F1)", async () => {
  const config = loadConfig(env());
  const manifest = loadManifest(config, readFixture);
  const result = await verifyDeployment(withNodeChainId(chainIdDouble()), manifest);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.ok ? undefined : result.failure, {
    kind: "ChainMismatch",
    expected: 31337n,
    actual: 56n,
  });
});

test("a chain id the node does not answer as a hex quantity is a refusal (F1)", async () => {
  const config = loadConfig(env());
  const manifest = loadManifest(config, readFixture);
  for (const answer of [null, 56, "56", "0x", "not-hex"]) {
    await assert.rejects(
      () =>
        assertChainId(
          config,
          {
            async send() {
              return answer;
            },
          },
          manifest,
        ),
      (error: unknown) => error instanceof StartupError && /not a hex quantity/.test(error.message),
      `a node answering ${JSON.stringify(answer)} must be refused`,
    );
  }
});

test("prepare runs the gates in order: manifest, key policy, chain id, then verification", async () => {
  const withKey = loadConfig(env({KEEPER_UNLOCKED_ADDRESS: undefined, KEEPER_PRIVATE_KEY: KEY}));
  await assert.rejects(
    () => prepare(withKey, nodeOn(31337n), readFixture),
    (error: unknown) => error instanceof StartupError && /local deployment/.test(error.message),
  );
  const unlocked = loadConfig(env());
  await assert.rejects(
    () => prepare(unlocked, nodeOn(97n), readFixture),
    (error: unknown) => error instanceof StartupError && /node reports chain 97/.test(error.message),
  );
  // The chain id passes, so the next gate is `verifyDeployment`, which this node cannot satisfy.
  await assert.rejects(
    () => prepare(unlocked, nodeOn(31337n), readFixture),
    (error: unknown) => error instanceof StartupError && /did not verify/.test(error.message),
  );
});

/**
 * The dangerous shape: the repository's own local manifest, mocks and all, re-pointed at chain 56.
 *
 * `parseManifest` refuses a mock only when `environment` is `testnet` or `mainnet`, so a file that still
 * says `local` carries every mock through every existing check. That is the gap `assertNoMocks` closes, and
 * it is the shape a copied or hand-edited manifest actually has.
 */
function mainnetLookalike(overrides: (json: Record<string, unknown>) => void = () => {}): string {
  const json = JSON.parse(MANIFEST_JSON) as Record<string, unknown>;
  (json.chain as Record<string, unknown>).chainId = Number(BSC_MAINNET_CHAIN_ID);
  json.deploymentId = `${BSC_MAINNET_CHAIN_ID}:${DRAW}`;
  overrides(json);
  return JSON.stringify(json);
}

const MAINNET_ENV: Environment = {
  KEEPER_RPC_URL: "https://bsc.example/rpc",
  KEEPER_CHAIN_ID: String(BSC_MAINNET_CHAIN_ID),
  KEEPER_DRAW_ADDRESS: DRAW,
  KEEPER_UNLOCKED_ADDRESS: UNLOCKED,
};

test("chain 56 refuses a manifest that names any mock, whatever its environment says", () => {
  const config = loadConfig(MAINNET_ENV);
  const manifest = loadManifest(config, () => mainnetLookalike());
  assert.throws(
    () => assertNoMocks(config, manifest),
    (error: unknown) =>
      error instanceof StartupError &&
      /refuses a manifest that names a mock/.test(error.message) &&
      // Every kind is named, so the operator sees the whole problem in one line.
      error.message.includes("mocks: MockERC20") &&
      error.message.includes("vrf.coordinatorIsMock") &&
      error.message.includes("assets[0].isMock") &&
      error.message.includes("assets[0].price.feedIsMock"),
  );
});

test("chain 56 refuses each kind of mock on its own", () => {
  const config = loadConfig(MAINNET_ENV);
  const clean = (json: Record<string, unknown>): void => {
    json.mocks = [];
    (json.vrf as Record<string, unknown>).coordinatorIsMock = false;
    for (const asset of json.assets as Record<string, unknown>[]) {
      asset.isMock = false;
      (asset.price as Record<string, unknown>).feedIsMock = false;
    }
  };
  const assetAt = (json: Record<string, unknown>, index: number): Record<string, unknown> => {
    const asset = (json.assets as Record<string, unknown>[])[index];
    assert.ok(asset !== undefined, `the fixture has no assets[${index}]`);
    return asset;
  };
  const cases: readonly [string, (json: Record<string, unknown>) => void][] = [
    [
      "mocks: MockERC20",
      (json) => {
        json.mocks = ["MockERC20"];
      },
    ],
    [
      "vrf.coordinatorIsMock",
      (json) => {
        (json.vrf as Record<string, unknown>).coordinatorIsMock = true;
      },
    ],
    [
      "assets[1].isMock",
      (json) => {
        assetAt(json, 1).isMock = true;
      },
    ],
    [
      "assets[1].price.feedIsMock",
      (json) => {
        (assetAt(json, 1).price as Record<string, unknown>).feedIsMock = true;
      },
    ],
  ];
  for (const [expected, taint] of cases) {
    const manifest = loadManifest(config, () =>
      mainnetLookalike((json) => {
        clean(json);
        taint(json);
      }),
    );
    assert.throws(
      () => assertNoMocks(config, manifest),
      (error: unknown) => error instanceof StartupError && error.message.includes(expected),
      `a manifest whose only mock is ${expected} must be refused`,
    );
  }
  // And with every one of them cleared, the same manifest passes.
  const clean56 = loadManifest(config, () => mainnetLookalike(clean));
  assert.doesNotThrow(() => assertNoMocks(config, clean56));
});

test("the mock gate is chain 56 only: local anvil still runs against labeled mocks", () => {
  const config = loadConfig(env());
  assert.doesNotThrow(() => assertNoMocks(config, loadManifest(config, readFixture)));
});

test("prepare refuses the mock before it asks the node anything (SPEC 12)", async () => {
  const config = loadConfig(MAINNET_ENV);
  const unreachable: StartupProvider = {
    ...noSnapshot("the node must not be reached"),
    async getNetwork(): Promise<{chainId: bigint}> {
      throw new Error("the node must not be reached");
    },
    async send(): Promise<unknown> {
      throw new Error("the node must not be reached");
    },
    async getCode(): Promise<string> {
      throw new Error("the node must not be reached");
    },
    async call(): Promise<string> {
      throw new Error("the node must not be reached");
    },
  };
  await assert.rejects(
    () => prepare(config, unreachable, () => mainnetLookalike()),
    (error: unknown) =>
      error instanceof StartupError && /refuses a manifest that names a mock/.test(error.message),
  );
});

test("eth_chainId is checked against KEEPER_CHAIN_ID as well as the manifest", async () => {
  // The two agree today because `loadManifest` refuses a manifest that disagrees with the variable; this is
  // the check that keeps holding if that ever stops being true.
  const config = loadConfig(MAINNET_ENV);
  const manifest = loadManifest(loadConfig(env()), readFixture);
  await assert.rejects(
    () => assertChainId(config, nodeOn(31337n), manifest),
    (error: unknown) =>
      error instanceof StartupError &&
      /node reports chain 31337 but KEEPER_CHAIN_ID is 56/.test(error.message),
  );
});

const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";

/** A chain record as `config/chains/<id>.json` shapes it. */
function chainRecord(chainId: number, multicall3: unknown): string {
  return JSON.stringify({
    chainId,
    name: "test-chain",
    confirmationDepth: 200,
    networkIdentity: {genesisHash: null, multicall3, source: {url: null, date: null}},
    rpcEnvVars: {},
  });
}

test("Multicall3 comes from the chain record, lowercased", () => {
  const config = loadConfig(env());
  assert.strictEqual(
    loadMulticall3(config, () => chainRecord(31337, MULTICALL3.toUpperCase().replace("0X", "0x"))),
    MULTICALL3,
  );
});

test("a null, absent or recordless Multicall3 is undefined, not a refusal", () => {
  const config = loadConfig(env());
  // chain 56's record carries null until the operator verifies the address against the live chain.
  assert.strictEqual(
    loadMulticall3(config, () => chainRecord(31337, null)),
    undefined,
  );
  assert.strictEqual(
    loadMulticall3(config, () => JSON.stringify({chainId: 31337, networkIdentity: {}})),
    undefined,
  );
  assert.strictEqual(
    loadMulticall3(config, () => JSON.stringify({chainId: 31337})),
    undefined,
  );
  // No file at all: a keeper pointed at a manifest tree outside the repository still runs, unbatched.
  assert.strictEqual(
    loadMulticall3(config, () => {
      throw new Error("ENOENT: no such file or directory");
    }),
    undefined,
  );
});

test("a chain record for another chain is a refusal, because its address is on another network", () => {
  const config = loadConfig(env());
  assert.throws(
    () => loadMulticall3(config, () => chainRecord(56, MULTICALL3)),
    (error: unknown) =>
      error instanceof ConfigError && /is for chain 56 but KEEPER_CHAIN_ID is 31337/.test(error.message),
  );
  assert.throws(() => loadMulticall3(config, () => chainRecord(31337, "not-an-address")), ConfigError);
  assert.throws(() => loadMulticall3(config, () => "{"), ConfigError);
  assert.throws(() => loadMulticall3(config, () => "[]"), ConfigError);
});

test("the repository's own chain records load", () => {
  // 31337 and 56 both carry null today; what this asserts is that the shape is the one this reader expects.
  for (const chainId of ["31337", "56"]) {
    const config = loadConfig(env({KEEPER_CHAIN_ID: chainId}));
    assert.strictEqual(loadMulticall3(config), undefined);
  }
});

test("a chain record whose chainId is not a number says so, rather than comparing 56 with 56 (F9)", () => {
  const config = loadConfig(env({KEEPER_CHAIN_ID: "56"}));
  // The JSON string "56" is the shape a hand-edited record actually has, and the old message read
  // "is for chain 56 but KEEPER_CHAIN_ID is 56", which names no fault the operator can act on.
  assert.throws(
    () => loadMulticall3(config, () => JSON.stringify({chainId: "56", networkIdentity: {}})),
    (error: unknown) =>
      error instanceof ConfigError &&
      /records chainId as a string, which is not a whole number/.test(error.message) &&
      !/is for chain 56 but/.test(error.message),
  );
  for (const [value, expected] of [
    [null, "null"],
    [[56], "an array"],
    [56.5, "a fractional number"],
  ] as const) {
    assert.throws(
      () => loadMulticall3(config, () => JSON.stringify({chainId: value, networkIdentity: {}})),
      (error: unknown) => error instanceof ConfigError && error.message.includes(`chainId as ${expected}`),
      `a chainId of ${JSON.stringify(value)} must be named as ${expected}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Gate 6: the Multicall3 the chain record names has to work
// ---------------------------------------------------------------------------

/** Runtime code the fake node reports for both contracts, with the manifest pointed at its hash. */
const CODE = "0x60006000fd";
const HEAD = {number: 4242, hash: `0x${"cd".repeat(32)}`, timestamp: 1_790_000_500};

/** The repository's own manifest with both code hashes replaced, so a fake node can satisfy gate 5. */
function verifiableManifest(): string {
  const json = JSON.parse(MANIFEST_JSON) as {
    contracts: {vault: Record<string, unknown>; draw: Record<string, unknown>};
  };
  json.contracts.vault.codeHash = keccak256(CODE);
  json.contracts.draw.codeHash = keccak256(CODE);
  return JSON.stringify(json);
}

/**
 * A node that satisfies gates 1-5, with the Multicall3 under test.
 *
 * The client's own recording fake serves `aggregate3`, so the probe here travels the exact path a cycle's
 * reads take: one `aggregate3` at the snapshot block, decoded by the client's decoder.
 */
function verifyingNode(
  options: {multicallCode?: string; aggregateReverts?: boolean} = {},
): StartupProvider & {calls: RecordedCall[]} {
  const manifest = parseManifest(JSON.parse(verifiableManifest()) as unknown);
  const vault = manifest.contracts.vault.address;
  const draw = manifest.contracts.draw.address;
  const fake = fakeProvider({
    chainId: 31337n,
    blocks: {latest: HEAD},
    byNumber: {"0x1092": HEAD},
  });
  fake.answer(draw, drawInterface.encodeFunctionData("VAULT", []), {
    ok: true,
    data: drawInterface.encodeFunctionResult("VAULT", [vault]),
  });
  fake.answer(vault, vaultInterface.encodeFunctionData("draw", []), {
    ok: true,
    data: vaultInterface.encodeFunctionResult("draw", [draw]),
  });
  // What the probe reads: one real cycle read of the Draw.
  fake.answer(draw, drawInterface.encodeFunctionData("getSeedAccount", []), {
    ok: true,
    data: drawInterface.encodeFunctionResult("getSeedAccount", [UNLOCKED]),
  });
  return {
    ...fake,
    async call(tx: {to: string; data: string; blockTag?: string | number}): Promise<string> {
      if (options.aggregateReverts === true && tx.to.toLowerCase() === MULTICALL3) {
        throw new Error("execution reverted");
      }
      return fake.call(tx);
    },
    async getCode(address: string): Promise<string> {
      return address.toLowerCase() === MULTICALL3 ? (options.multicallCode ?? CODE) : CODE;
    },
    async send(method: string): Promise<unknown> {
      if (method !== "eth_chainId") throw new Error(`unexpected request ${method}`);
      return "0x7a69";
    },
  };
}

/** The manifest and the chain record come from the same reader; they are different paths. */
function readTree(multicall3: unknown): (path: string) => string {
  return (path) => (path.includes("chains") ? chainRecord(31337, multicall3) : verifiableManifest());
}

test("prepare verifies the Multicall3 the chain record names and returns it (F3/F4)", async () => {
  const config = loadConfig(env());
  const node = verifyingNode();
  const prepared = await prepare(config, node, readTree(MULTICALL3));
  assert.strictEqual(prepared.multicall3, MULTICALL3);
  // The probe is a real `aggregate3`, not a `getCode` and a hope.
  assert.ok(
    node.calls.some((call) => call.to === MULTICALL3),
    "the start-up probe never reached Multicall3",
  );
});

test("a Multicall3 address with no code is a refusal naming Multicall3 (F4)", async () => {
  const config = loadConfig(env());
  await assert.rejects(
    () => prepare(config, verifyingNode({multicallCode: "0x"}), readTree(MULTICALL3)),
    (error: unknown) =>
      error instanceof StartupError &&
      error.message.includes("Multicall3") &&
      /has no code on chain 31337/.test(error.message) &&
      // The message says where the wrong address came from and how to run without it.
      error.message.includes("networkIdentity.multicall3") &&
      error.message.includes("set it to null"),
  );
});

test("a Multicall3 whose aggregate3 fails is a refusal, not ten failed cycles a restart apart (F4)", async () => {
  const config = loadConfig(env());
  await assert.rejects(
    () => prepare(config, verifyingNode({aggregateReverts: true}), readTree(MULTICALL3)),
    (error: unknown) =>
      error instanceof StartupError &&
      /Multicall3 .* did not answer an aggregate3 probe/.test(error.message) &&
      /execution reverted/.test(error.message),
  );
});

test("no Multicall3 in the chain record means no probe and no refusal", async () => {
  const config = loadConfig(env());
  const node = verifyingNode({multicallCode: "0x"});
  const prepared = await prepare(config, node, readTree(null));
  assert.strictEqual(prepared.multicall3, undefined);
  assert.ok(
    !node.calls.some((call) => call.to === MULTICALL3),
    "a keeper without batching must not probe an address it will never use",
  );
});
