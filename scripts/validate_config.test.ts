// Tests for scripts/validate_config.ts, run with Node's built-in runner:
//     node --test scripts/validate_config.test.ts
//
// Every failing case starts from one of the three checked-in fixture roots under
// scripts/config_fixtures/, applies a single named mutation in a temporary copy, and asserts the exact
// set of rule tags the validator reports. Asserting the whole set, not just "it failed", is what makes
// each fixture fail for its stated reason and nothing else.

import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {after, describe, it} from "node:test";
import type {FileResult, RunResult} from "./validate_config.ts";
import {report, validateTree} from "./validate_config.ts";

const SCRIPT_DIR: string = import.meta.dirname;
const REPO_ROOT: string = join(SCRIPT_DIR, "..");
const FIXTURES: string = join(SCRIPT_DIR, "config_fixtures");
const VALIDATOR: string = join(SCRIPT_DIR, "validate_config.ts");

const LOCAL_MANIFEST = "deployments/31337/0x2222222222222222222222222222222222222222.json";
const MAINNET_MANIFEST = "deployments/56/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json";
const MAINNET_RELEASE_AUTHORITY = "release-authority/bsc-mainnet.json";
const TESTNET_PLAN = "deployments/97/first-testnet.plan.json";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, {recursive: true, force: true});
  }
});

/** Copy a checked-in fixture root into a fresh temporary directory. */
function copyFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "luckydraw-config-"));
  temporaryRoots.push(root);
  cpSync(join(FIXTURES, name), root, {recursive: true});
  return root;
}

function readDoc(root: string, relative: string): Record<string, any> {
  return JSON.parse(readFileSync(join(root, relative), "utf8")) as Record<string, any>;
}

function writeDoc(root: string, relative: string, doc: unknown): void {
  writeFileSync(join(root, relative), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

function patch(root: string, relative: string, mutate: (doc: Record<string, any>) => void): void {
  const doc = readDoc(root, relative);
  mutate(doc);
  writeDoc(root, relative, doc);
}

/** The single result whose path ends with `suffix`. */
function resultFor(run: RunResult, suffix: string): FileResult {
  const matches = run.results.filter((r) => r.path.endsWith(suffix));
  assert.equal(
    matches.length,
    1,
    `expected exactly one result for ${suffix}, got ${matches.length}\n${report(run)}`,
  );
  return matches[0];
}

/** Sorted, de-duplicated rule tags, e.g. ["D1"] or ["P1", "schema"]. */
function tagsOf(result: FileResult): string[] {
  const tags = result.errors.map((error) => {
    const match = error.match(/^\[([^\]]+)\]/);
    return match === null ? "?" : match[1];
  });
  return [...new Set(tags)].sort();
}

function assertRules(result: FileResult, expected: string[]): void {
  assert.deepEqual(
    tagsOf(result),
    expected,
    `expected rules ${expected.join(", ")} for ${result.path}; got:\n  ${result.errors.join("\n  ") || "(no errors)"}`,
  );
}

/** Copy a fixture, mutate one document, validate, and return that document's result. */
function caseFor(fixture: string, relative: string, mutate: (doc: Record<string, any>) => void): FileResult {
  const root = copyFixture(fixture);
  patch(root, relative, mutate);
  return resultFor(validateTree(root), relative.split("/").pop() as string);
}

// ---------------------------------------------------------------------------

describe("document roots", () => {
  for (const value of [null, [], "text", 42, true]) {
    it(`rejects ${JSON.stringify(value)} through the library and CLI`, () => {
      const root = copyFixture("valid-local");
      writeDoc(root, LOCAL_MANIFEST, value);
      assertRules(resultFor(validateTree(root), LOCAL_MANIFEST), ["G0"]);
      const cli = spawnSync(process.execPath, [VALIDATOR, root], {encoding: "utf8"});
      assert.equal(cli.status, 1, cli.stdout + cli.stderr);
      assert.match(cli.stdout, /top level is not a JSON object/);
    });
  }
});

describe("the checked-in trees validate", () => {
  it("the repository's own config/ tree has no errors", () => {
    const run = validateTree(join(REPO_ROOT, "config"));
    assert.equal(run.failed, 0, report(run));
    assert.ok(run.results.length > 0, "config/ contained no documents");
  });

  it("valid-local passes with no errors and no warnings", () => {
    const run = validateTree(join(FIXTURES, "valid-local"));
    assert.equal(run.failed, 0, report(run));
    assert.equal(run.warnings, 0, report(run));
    assert.equal(run.results.length, 2);
  });

  it("valid-mainnet passes with no errors and no warnings", () => {
    const run = validateTree(join(FIXTURES, "valid-mainnet"));
    assert.equal(run.failed, 0, report(run));
    assert.equal(run.warnings, 0, report(run));
  });

  it("valid-plan passes, warning only that testnet shares one operator Safe", () => {
    const run = validateTree(join(FIXTURES, "valid-plan"));
    assert.equal(run.failed, 0, report(run));
    const result = resultFor(run, "first-testnet.plan.json");
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^\[O2w\].*one operator Safe on testnet/);
  });
});

describe("identifiers and file names", () => {
  it("D1: a deploymentId that is not chainId + ':' + Draw address is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.deploymentId = "31337:0x1111111111111111111111111111111111111111";
    });
    assertRules(result, ["D1"]);
    assert.match(result.errors[0], /expected "31337:0x2222/);
  });

  it("D2: a manifest under the wrong chain directory is rejected", () => {
    const root = copyFixture("valid-local");
    patch(root, LOCAL_MANIFEST, (doc) => {
      doc.chain.chainId = 97;
    });
    const result = resultFor(validateTree(root), "0x2222222222222222222222222222222222222222.json");
    assert.ok(tagsOf(result).includes("D2"), result.errors.join("\n"));
  });

  it("D3: a manifest not named after its Draw address is rejected", () => {
    const root = copyFixture("valid-local");
    const renamed = "deployments/31337/0x9999999999999999999999999999999999999999.json";
    renameSync(join(root, LOCAL_MANIFEST), join(root, renamed));
    // Renaming alone leaves deploymentId consistent with the Draw address, so D3 is the only failure:
    // the path is the thing that disagrees.
    const result = resultFor(validateTree(root), "0x9999999999999999999999999999999999999999.json");
    assertRules(result, ["D3"]);
    assert.ok(result.errors.some((e) => e.startsWith("[D3]") && e.includes("named after its Draw address")));
  });

  it("CH1: a chain record not named after its chain id is rejected", () => {
    const root = copyFixture("valid-local");
    renameSync(join(root, "chains/31337.json"), join(root, "chains/99999.json"));
    const result = resultFor(validateTree(root), "chains/99999.json");
    assertRules(result, ["CH1"]);
  });

  it("A2: an asset record not named after its lowercase symbol is rejected", () => {
    const root = copyFixture("valid-local");
    cpSync(join(REPO_ROOT, "config", "assets"), join(root, "assets"), {recursive: true});
    renameSync(join(root, "assets/31337/test2.json"), join(root, "assets/31337/wrongname.json"));
    const result = resultFor(validateTree(root), "assets/31337/wrongname.json");
    assertRules(result, ["A2"]);
  });

  it("A9: requiresZeroReset is accepted as a boolean and rejected as anything else", () => {
    for (const value of [true, false]) {
      const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
        doc.assets[1].requiresZeroReset = value;
      });
      assertRules(result, []);
    }
    // A string is not a boolean: "false" is truthy in a naive consumer, and "true" would silently add an
    // approve(0) step (SPEC 9.5). The schema and the A9 rule both catch it.
    const asString = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.assets[1].requiresZeroReset = "true";
    });
    assertRules(asString, ["A9", "schema"]);
    // Native BNB has no approve to reset.
    const onNative = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.assets[0].requiresZeroReset = true;
    });
    assertRules(onNative, ["A9"]);
  });

  it("L1: a JSON document in a directory that implies no schema is rejected", () => {
    const root = copyFixture("valid-local");
    writeDoc(root, "stray.json", {hello: "world"});
    const result = resultFor(validateTree(root), "stray.json");
    assertRules(result, ["L1"]);
  });

  it("G2: a file with CRLF endings is rejected", () => {
    const root = copyFixture("valid-local");
    const path = join(root, LOCAL_MANIFEST);
    writeFileSync(path, readFileSync(path, "utf8").split("\n").join("\r\n"), "utf8");
    const result = resultFor(validateTree(root), "0x2222222222222222222222222222222222222222.json");
    assertRules(result, ["G2"]);
  });
});

describe("the mock boundary", () => {
  it("D4: a mainnet manifest that lists a mock artifact is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.mocks = ["MockERC20"];
    });
    assertRules(result, ["D4", "schema"]);
    assert.ok(result.errors.some((e) => e.startsWith("[D4]") && e.includes("MockERC20")));
  });

  it("M1: a mainnet manifest whose feed is a mock is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.feedIsMock = true;
    });
    assertRules(result, ["M1"]);
    assert.match(result.errors[0], /feedIsMock is true in a mainnet document/);
  });

  it("M1: a mainnet manifest whose coordinator is a mock is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.vrf.coordinatorIsMock = true;
    });
    assertRules(result, ["M1"]);
  });

  it("local manifests may carry mocks", () => {
    const run = validateTree(join(FIXTURES, "valid-local"));
    const result = resultFor(run, "0x2222222222222222222222222222222222222222.json");
    assert.deepEqual(result.errors, []);
  });
});

describe("custody", () => {
  it("O1: mainnet with owner and treasury sharing one Safe is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.ownership.feeAccount = doc.ownership.finalOwner;
      doc.contracts.draw.constructorArgs.feeAccount = doc.ownership.finalOwner;
    });
    assertRules(result, ["O1"]);
    assert.match(result.errors[0], /separate owner, treasury and seed Safes/);
  });

  it("testnet may share one operator Safe (warning, not an error)", () => {
    const run = validateTree(join(FIXTURES, "valid-plan"));
    assert.equal(run.failed, 0, report(run));
  });

  it("D16: accepted ownership must leave both contracts owned by finalOwner with nothing pending", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.ownership.ownershipAccepted = true;
    });
    assertRules(result, ["D16"]);
    assert.equal(result.errors.length, 4); // owner and pendingOwner, on Vault and Draw
  });
});

describe("price policy", () => {
  it("schema + P1: a maxPriceAge outside 60..172800 is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.maxPriceAge = 200000;
    });
    assertRules(result, ["P1", "schema"]);
    assert.ok(result.errors.some((e) => e.includes("172800")));
  });

  it("P1: an in-range maxPriceAge that is not max(2H, 3600) is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.heartbeatSeconds = 1800;
      doc.assets[0].price.maxPriceAge = 7200;
    });
    assertRules(result, ["P1"]);
    assert.match(result.errors[0], /max\(2H, 3600\) = 3600/);
  });

  it("P1: 2H wins over the 3600 floor for a slow feed", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.heartbeatSeconds = 86400;
      doc.assets[0].price.maxPriceAge = 3600;
    });
    assertRules(result, ["P1"]);
    assert.match(result.errors[0], /= 172800/);
  });

  it("P1: a mainnet manifest with no heartbeat is rejected, whatever maxPriceAge it claims", () => {
    // Without a heartbeat the max(2H, 3600) rule cannot be applied, so the bare 60..172800 bounds check
    // used to accept the longest tolerable age on a real network with nothing to justify it.
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.heartbeatSeconds = null;
      doc.assets[0].price.maxPriceAge = 172800;
    });
    assertRules(result, ["P1"]);
    assert.match(result.errors[0], /heartbeatSeconds is null in a mainnet document/);
    assert.match(result.errors[0], /only a local mock may omit it/);
  });

  it("P1: a testnet plan with no heartbeat is rejected", () => {
    const result = caseFor("valid-plan", TESTNET_PLAN, (doc) => {
      doc.assets[0].price.heartbeatSeconds = null;
    });
    assertRules(result, ["P1"]);
    assert.match(result.errors[0], /heartbeatSeconds is null in a testnet document/);
  });

  it("schema + P1: a mainnet manifest with no heartbeatSeconds key at all is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      delete doc.assets[0].price.heartbeatSeconds;
    });
    assertRules(result, ["P1", "schema"]);
    assert.ok(result.errors.some((e) => e.includes("heartbeatSeconds is absent in a mainnet document")));
  });

  it("a local manifest keeps the null-heartbeat escape hatch", () => {
    const run = validateTree(join(FIXTURES, "valid-local"));
    const result = resultFor(run, "0x2222222222222222222222222222222222222222.json");
    assert.deepEqual(result.errors, []); // assets[0].price.heartbeatSeconds is null in this fixture
  });

  it("a mainnet manifest with a heartbeat and the matching maxPriceAge passes", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.heartbeatSeconds = 3600;
      doc.assets[0].price.maxPriceAge = 7200;
    });
    assertRules(result, []);
  });

  it("P2: minAnswer at or above maxAnswer is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.minAnswer = "1000000000000";
    });
    assertRules(result, ["P2"]);
  });

  it("P3: an UnderlyingAsset reference without a label and peg assumption is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.referenceKind = "UnderlyingAsset";
    });
    assertRules(result, ["P3"]);
    assert.equal(result.errors.length, 2);
  });
});

describe("deployed code and constructor agreement", () => {
  it("schema + D8: a Draw record without its constructorArgs is rejected", () => {
    // Regression guard: the record was once keyed `constructor`, which every JSON object inherits from
    // Object.prototype; Ajv runs with ownProperties so no inherited name can satisfy `required`.
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      delete doc.contracts.draw.constructorArgs;
    });
    assertRules(result, ["D8", "schema"]);
    assert.ok(result.errors.some((e) => e.includes("must have required property 'constructorArgs'")));
  });

  it("D9: a constructor pointing at a different Vault is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.contracts.draw.constructorArgs.vault = "0x5555555555555555555555555555555555555555";
    });
    assertRules(result, ["D9"]);
  });

  it("D10: a constructor key hash that differs from the VRF record is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.contracts.draw.constructorArgs.keyHash = `0x${"1".repeat(64)}`;
    });
    assertRules(result, ["D10"]);
    assert.match(result.errors[0], /constructor-fixed/);
  });

  it("D11: a constructor fee account that differs from the ownership record is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.contracts.draw.constructorArgs.feeAccount = "0x5555555555555555555555555555555555555555";
    });
    assertRules(result, ["D11"]);
  });

  it("D25: a manifest where Vault and Draw are the same address is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.contracts.vault.address = doc.contracts.draw.address;
      doc.contracts.draw.constructorArgs.vault = doc.contracts.draw.address;
    });
    assertRules(result, ["D25"]);
  });

  it("T1: a toolchain that disagrees with contracts/foundry.toml is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.toolchain.solc = "0.8.27";
      doc.toolchain.optimizerRuns = 200;
    });
    assertRules(result, ["T1"]);
    assert.equal(result.errors.length, 2);
  });
});

describe("pools", () => {
  it("D12: two pools sharing a poolId are rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.assets[1].pool.poolId = "1";
    });
    assertRules(result, ["D12"]);
  });

  it("D13: firstRoundIds that do not increase strictly across pools are rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.assets[1].pool.firstRoundIds = ["7", "9", "10", "11", "12", "13", "14"];
    });
    assertRules(result, ["D13"]);
  });

  // ADR 036 widened Kind from three members to seven. A manifest that lost its round ids, or that still
  // carries the three-kind shape, asserts on-chain facts that are not true: rounds 4 to 7 of that pool do
  // not exist. The manifest schema requires all seven; the plan schema forbids the field outright, because
  // nothing is deployed when a plan is written. Both halves are pinned here.
  it("a manifest with no firstRoundIds at all is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      delete doc.assets[0].pool.firstRoundIds;
    });
    assertRules(result, ["schema"]);
  });

  it("a manifest still carrying the three-kind firstRoundIds is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.assets[0].pool.firstRoundIds = ["1", "2", "3"];
    });
    assertRules(result, ["schema"]);
  });

  it("a plan may not carry firstRoundIds, because nothing is deployed when it is written", () => {
    const result = caseFor("valid-plan", TESTNET_PLAN, (doc) => {
      doc.assets[0].pool.firstRoundIds = ["1", "2", "3", "4", "5", "6", "7"];
    });
    assertRules(result, ["schema"]);
  });

  it("D15: a seedAmount above the authorized per-round cap is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.assets[0].pool.seedAuthorizedMaxPerRound = "1";
    });
    assertRules(result, ["D15"]);
    assert.match(result.errors[0], /NotAuthorized/);
  });

  it("D19: a repeated asset symbol is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.assets[1].symbol = "BNB";
    });
    assert.ok(tagsOf(result).includes("D19"), result.errors.join("\n"));
  });

  it("schema: a target below MIN_TARGET_USD is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.assets[0].pool.targetsUsd.Day100 = 5;
    });
    assertRules(result, ["schema"]);
    assert.ok(result.errors.some((e) => e.includes(">= 10")));
  });
});

describe("VRF", () => {
  it("V1: a maxRequestCostNative below its own derivation is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.vrf.maxRequestCostNative = "1000000000000";
      doc.contracts.draw.constructorArgs.maxRequestCostNative = "1000000000000";
    });
    assertRules(result, ["V1"]);
    assert.match(result.errors[0], /2500000000000000 wei/);
  });

  it("D22: a mainnet manifest with an unregistered consumer is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.vrf.consumerRegistered = false;
    });
    assertRules(result, ["D22"]);
  });

  it("schema: requestConfirmations other than 200 is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.vrf.requestConfirmations = 3;
      doc.contracts.draw.constructorArgs.requestConfirmations = 3;
    });
    assertRules(result, ["schema"]);
    assert.equal(result.errors.length, 2); // once in the VRF record, once in the constructor
  });

  it("schema: numWords other than 2 is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.vrf.numWords = 1;
    });
    assertRules(result, ["schema"]);
  });
});

describe("environment and chain agreement", () => {
  it("E1: a manifest calling chain 56 a testnet is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.environment = "testnet";
    });
    assertRules(result, ["E1"]);
  });

  it("CH2: a manifest with the wrong explorer for its chain is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.chain.explorerUrl = "https://testnet.bscscan.com";
    });
    assertRules(result, ["CH2"]);
  });

  // The player-facing name is the one string a mismatch would turn into a lie: a build that calls chain 56
  // "BNB Smart Chain Testnet" — or chain 97 "BNB Smart Chain" — tells the player to put real money on the
  // wrong network. CH2 pins it on the chain record and on the copy a manifest embeds.
  it("CH2: a chain record naming mainnet as a testnet is rejected", () => {
    const result = caseFor("valid-mainnet", "chains/56.json", (doc) => {
      doc.displayName = "BNB Smart Chain Testnet";
    });
    assertRules(result, ["CH2"]);
    assert.ok(
      result.errors.some((e) => e.startsWith("[CH2]") && e.includes('"BNB Smart Chain"')),
      `expected the CH2 message to name the expected display name; got:\n  ${result.errors.join("\n  ")}`,
    );
  });

  it("schema: a chain record with no displayName at all is rejected", () => {
    const result = caseFor("valid-mainnet", "chains/56.json", (doc) => {
      delete doc.displayName;
    });
    assertRules(result, ["schema"]);
    assert.ok(
      result.errors.some((e) => e.includes("required property 'displayName'")),
      `expected a missing-required-property error for displayName; got:\n  ${result.errors.join("\n  ")}`,
    );
  });

  it("CH2: a manifest embedding the wrong display name for its chain is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.chain.displayName = "BNB Smart Chain Testnet";
    });
    assertRules(result, ["CH2"]);
  });
});

describe("plans", () => {
  it("TPL: a template plan is always rejected", () => {
    const result = caseFor("valid-plan", TESTNET_PLAN, (doc) => {
      doc.template = true;
    });
    assertRules(result, ["TPL"]);
    assert.match(result.errors[0], /blank form/);
  });

  it("a template flag set to false is not a rejection", () => {
    const result = caseFor("valid-plan", TESTNET_PLAN, (doc) => {
      doc.template = false;
    });
    assertRules(result, []);
  });

  it("schema: a plan carrying deployed facts is rejected", () => {
    const result = caseFor("valid-plan", TESTNET_PLAN, (doc) => {
      doc.contracts = {};
    });
    assertRules(result, ["schema"]);
    assert.ok(result.errors.some((e) => e.includes("/contracts") && e.includes("not allowed here")));
  });

  it("schema: a plan that assigns a poolId is rejected", () => {
    const result = caseFor("valid-plan", TESTNET_PLAN, (doc) => {
      doc.assets[0].pool.poolId = "1";
    });
    assertRules(result, ["schema"]);
  });

  it("PL3: a plan whose name disagrees with its file name is rejected", () => {
    const result = caseFor("valid-plan", TESTNET_PLAN, (doc) => {
      doc.name = "something-else";
    });
    assertRules(result, ["PL3"]);
  });

  it("M1: a testnet plan referencing a mock feed is rejected", () => {
    const result = caseFor("valid-plan", TESTNET_PLAN, (doc) => {
      doc.assets[0].price.feedIsMock = true;
    });
    assertRules(result, ["M1"]);
  });
});

describe("uint256 handling", () => {
  it("G1: a decimal string above 2^256-1 is rejected", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.assets[0].pool.seedAmount = (2n ** 256n).toString();
    });
    assert.ok(tagsOf(result).includes("G1"), result.errors.join("\n"));
  });

  it("a uint256 at the maximum is accepted", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.assets[0].pool.seedAuthorizedMaxPerRound = (2n ** 256n - 1n).toString();
      doc.assets[0].pool.seedAmount = (2n ** 256n - 1n).toString();
    });
    assertRules(result, []);
  });
});

describe("the make-whole reserve", () => {
  it("O4: a mainnet manifest with a zero make-whole reserve is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.ownership.makeWholeReserve = "0";
    });
    assertRules(result, ["O4"]);
    assert.match(result.errors[0], /funded make-whole reserve with a nonzero cap/);
  });

  it("O4: a mainnet manifest with no make-whole cap is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.ownership.makeWholeCap = null;
    });
    assertRules(result, ["O4"]);
    assert.ok(result.errors[0].includes("makeWholeCap"));
  });

  it("O4: both unfunded produces one error each", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.ownership.makeWholeReserve = null;
      doc.ownership.makeWholeCap = null;
    });
    assertRules(result, ["O4"]);
    assert.equal(result.errors.length, 2);
  });

  it("local may leave the reserve null or zero", () => {
    const result = caseFor("valid-local", LOCAL_MANIFEST, (doc) => {
      doc.ownership.makeWholeReserve = "0";
      doc.ownership.makeWholeCap = "0";
    });
    assertRules(result, []);
  });
});

describe("the customer launch gate", () => {
  const shakedown = {
    performed: true,
    date: "2026-09-20",
    roundIds: [7, 8],
    callbackGasUsed: 118000,
    requestToFulfilmentSeconds: 92,
    costPerDrawNativeWei: "2500000000000000",
  };

  it("a mainnet manifest with no release object is accepted and means customerLaunch false", () => {
    const run = validateTree(join(FIXTURES, "valid-mainnet"));
    const result = resultFor(run, MAINNET_MANIFEST.split("/").pop() as string);
    assert.deepEqual(result.errors, []);
    assert.equal(readDoc(join(FIXTURES, "valid-mainnet"), MAINNET_MANIFEST).release, undefined);
  });

  it("D26: customerLaunch true with no shakedown is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.release = {customerLaunch: true, shakedown: null};
    });
    assertRules(result, ["D26"]);
    assert.match(result.errors[0], /one full round and one refund alone/);
  });

  it("D26: customerLaunch true with an unperformed shakedown is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.release = {customerLaunch: true, shakedown: {...shakedown, performed: false}};
    });
    assertRules(result, ["D26"]);
  });

  it("customerLaunch true after a recorded shakedown passes", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.release = {customerLaunch: true, shakedown};
    });
    assertRules(result, []);
  });

  it("customerLaunch false before the shakedown passes", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.release = {customerLaunch: false, shakedown: null};
    });
    assertRules(result, []);
  });

  it("D27: a performed shakedown with no measured callback gas is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.release = {customerLaunch: false, shakedown: {...shakedown, callbackGasUsed: null}};
    });
    assertRules(result, ["D27"]);
    assert.match(result.errors[0], /cost per draw/);
  });

  it("D27: a performed shakedown that played no round is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.release = {customerLaunch: true, shakedown: {...shakedown, roundIds: []}};
    });
    assertRules(result, ["D27"]);
    assert.match(result.errors[0], /rounds the shakedown actually played/);
  });

  it("schema: an unknown key under release is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.release = {customerLaunch: false, shakedown: null, launched: true};
    });
    assertRules(result, ["schema"]);
  });

  // D27 used to check presence and type only, so a launch could be opened on numbers nobody measured.
  // Each case below is a value no real fulfilment can produce.
  describe("impossible shakedown measurements", () => {
    it("schema + D27: zero callback gas is rejected", () => {
      const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
        doc.release = {customerLaunch: true, shakedown: {...shakedown, callbackGasUsed: 0}};
      });
      assertRules(result, ["D27", "schema"]);
      assert.ok(result.errors.some((e) => e.startsWith("[D27]") && e.includes("cannot have used no gas")));
    });

    it("D27: callback gas above vrf.callbackGasLimit is rejected", () => {
      // In range for the schema, impossible on chain: the coordinator caps the callback at the limit.
      const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
        doc.release = {
          customerLaunch: true,
          shakedown: {...shakedown, callbackGasUsed: doc.vrf.callbackGasLimit + 1},
        };
      });
      assertRules(result, ["D27"]);
      assert.match(result.errors[0], /above vrf\.callbackGasLimit \(300000\)/);
    });

    it("callback gas exactly at the limit is accepted", () => {
      const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
        doc.release = {
          customerLaunch: true,
          shakedown: {...shakedown, callbackGasUsed: doc.vrf.callbackGasLimit},
        };
      });
      assertRules(result, []);
    });

    it("schema + D27: zero request-to-fulfilment latency is rejected", () => {
      const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
        doc.release = {customerLaunch: true, shakedown: {...shakedown, requestToFulfilmentSeconds: 0}};
      });
      assertRules(result, ["D27", "schema"]);
      assert.ok(result.errors.some((e) => e.startsWith("[D27]") && e.includes("positive number of seconds")));
    });

    it('schema + D27: a cost per draw of "0" is rejected', () => {
      const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
        doc.release = {customerLaunch: true, shakedown: {...shakedown, costPerDrawNativeWei: "0"}};
      });
      assertRules(result, ["D27", "schema"]);
      assert.ok(result.errors.some((e) => e.startsWith("[D27]") && e.includes("cannot have cost nothing")));
    });

    it("D27: a shakedown dated before the manifest was created is rejected", () => {
      const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
        doc.release = {customerLaunch: true, shakedown: {...shakedown, date: "2026-09-10"}};
      });
      assertRules(result, ["D27"]);
      assert.match(result.errors[0], /cannot predate the deployment it measures/);
    });

    it("a shakedown dated on the day the manifest was created is accepted", () => {
      const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
        doc.release = {customerLaunch: true, shakedown: {...shakedown, date: "2026-09-11"}};
      });
      assertRules(result, []);
    });
  });
});

describe("the observed feed interval", () => {
  it("P6: a mainnet price record with no observed p99.9 interval is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.observedP999IntervalSeconds = null;
    });
    assertRules(result, ["P6"]);
    assert.match(result.errors[0], /observe_feed/);
  });

  it("P7: an observed interval above maxPriceAge is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.observedP999IntervalSeconds = 4000;
    });
    assertRules(result, ["P7"]);
    assert.match(result.errors[0], /maxPriceAge is 3600/);
  });

  // A deviation-driven feed updates far more often than its heartbeat, so a short observed interval is
  // normal and is deliberately not an error.
  it("an observed interval far below the heartbeat is accepted", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.observedP999IntervalSeconds = 3;
    });
    assertRules(result, []);
  });

  it("P8: a mainnet price record with no observation window is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      delete doc.assets[0].price.observationWindow;
    });
    assertRules(result, ["P8"]);
    assert.match(result.errors[0], /fromBlock, toBlock, samples/);
  });

  it("P8: an observation window that does not move forward is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.assets[0].price.observationWindow.toBlock = 900000;
    });
    assertRules(result, ["P8"]);
  });

  it("schema: an observation window with no sample count is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      delete doc.assets[0].price.observationWindow.samples;
    });
    assertRules(result, ["P8", "schema"]);
  });

  it("a local manifest needs neither the interval nor the window", () => {
    const run = validateTree(join(FIXTURES, "valid-local"));
    assert.deepEqual(resultFor(run, LOCAL_MANIFEST.split("/").pop() as string).errors, []);
  });
});

describe("the recovery drill", () => {
  it("RA2: an unperformed drill is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.performed = false;
    });
    assertRules(result, ["RA2"]);
    assert.match(result.errors[0], /performed on the mainnet Safes/);
    // The rule no longer says "testnet": SPEC 14 moves the drill to the mainnet Safes.
    assert.ok(!result.errors.some((e) => e.includes("testnet")), result.errors.join("\n"));
  });

  it("RA2: a drill where one signer alone could still act is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.compromisedSignerBlocked = false;
    });
    assertRules(result, ["RA2"]);
    assert.match(result.errors[0], /one signer alone could not act/);
  });

  it("RA2: a drill with no proven treasury withdrawal is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.treasuryWithdrawalProven = false;
    });
    assertRules(result, ["RA2"]);
  });

  it("RA2: a drill performed on another chain's Safes is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.chainId = 97;
    });
    assertRules(result, ["RA2"]);
    assert.match(result.errors[0], /releases on chain 56/);
  });

  it("schema + RA2: a drill with no chainId at all is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      delete doc.custody.recoveryDrill.chainId;
    });
    assertRules(result, ["RA2", "schema"]);
  });

  it("RA2: a drill with no date is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.date = null;
    });
    assertRules(result, ["RA2"]);
  });

  it("RA2: a drill with no recorded Safes is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.safes = null;
    });
    assertRules(result, ["RA2"]);
    assert.match(result.errors[0], /owner, treasury and seed Safe addresses/);
  });

  it("RA2: a drill on Safes other than the manifest's is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.safes.treasury = "0x5050505050505050505050505050505050505050";
    });
    assertRules(result, ["RA2"]);
    assert.match(result.errors[0], /ownership\.feeAccount/);
  });

  it("RA2: a drill with no receipt pointers is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.receiptRefs = [];
    });
    assertRules(result, ["RA2"]);
    assert.match(result.errors[0], /never the restricted material itself/);
  });

  it("RA2: a drill dated after the manifest was created is rejected", () => {
    // SPEC 10.5 puts the drill before Deploy. A later date leaves a window in which undrilled keys held
    // the owner, treasury and seed roles, and it cannot be the drill that authorised the release.
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.date = "2026-09-14"; // the manifest's createdAtUtc is 2026-09-11
    });
    assertRules(result, ["RA2"]);
    assert.match(result.errors[0], /before the contracts are deployed/);
  });

  it("RA2: a drill dated on the day of deployment is accepted", () => {
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.date = "2026-09-11";
    });
    assertRules(result, []);
  });

  it("RA2: the drill-date comparison is silent when the manifest is not in the tree", () => {
    const root = copyFixture("valid-mainnet");
    rmSync(join(root, MAINNET_MANIFEST));
    patch(root, MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.date = "2099-01-01";
    });
    assertRules(resultFor(validateTree(root), "bsc-mainnet.json"), []);
  });

  it("E1: a mainnet record whose deploymentId is on chain 97 is rejected", () => {
    const root = copyFixture("valid-mainnet");
    patch(root, MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.deploymentId = `97:${doc.deploymentId.split(":")[1]}`;
      doc.custody.recoveryDrill.chainId = 97; // otherwise RA2 fires as well
    });
    const run = validateTree(root);
    const record = resultFor(run, "bsc-mainnet.json");
    assertRules(record, ["E1"]);
    assert.match(record.errors[0], /the only mainnet in this product is BSC \(56\)/);
    // And the manifest it no longer names is now uncovered.
    assertRules(resultFor(run, MAINNET_MANIFEST.split("/").pop() as string), ["RA3"]);
  });

  it("the Safe comparison is silent when the manifest is not in the tree", () => {
    const root = copyFixture("valid-mainnet");
    rmSync(join(root, MAINNET_MANIFEST));
    patch(root, MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.custody.recoveryDrill.safes.owner = "0x5050505050505050505050505050505050505050";
    });
    assertRules(resultFor(validateTree(root), "bsc-mainnet.json"), []);
  });

  it("RA3: a non-mainnet record may not exempt a mainnet manifest from RA1 and RA2", () => {
    // RA1/RA2 are still skipped on a non-mainnet record, which is why RA3 exists: the record covering a
    // mainnet manifest is reported for calling itself a testnet record, rather than silently exempted.
    const result = caseFor("valid-mainnet", MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.environment = "testnet";
      doc.custody.recoveryDrill.performed = false;
    });
    assertRules(result, ["RA3"]);
    assert.match(result.errors[0], /is the release authority for mainnet manifest/);
  });

  it("a non-mainnet record that covers no mainnet manifest is not subject to RA1, RA2 or RA3", () => {
    const root = copyFixture("valid-mainnet");
    rmSync(join(root, MAINNET_MANIFEST));
    patch(root, MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.environment = "testnet";
      doc.custody.recoveryDrill.performed = false;
    });
    assertRules(resultFor(validateTree(root), "bsc-mainnet.json"), []);
  });
});

// Finding 1 of the 2026-09-16 review: RA1 and RA2 only ever ran from a matching mainnet record, so a
// manifest with no record, a record labelled testnet, or a record naming some other deployment all let a
// mainnet manifest reach customers with no recovery drill recorded anywhere. RA3 walks the other way,
// from every mainnet manifest to its record.
describe("every mainnet manifest has a release authority", () => {
  const shakedown = {
    performed: true,
    date: "2026-09-20",
    roundIds: [7, 8],
    callbackGasUsed: 118000,
    requestToFulfilmentSeconds: 92,
    costPerDrawNativeWei: "2500000000000000",
  };

  it("RA3: a customer launch with the release-authority record deleted is rejected", () => {
    const root = copyFixture("valid-mainnet");
    patch(root, MAINNET_MANIFEST, (doc) => {
      doc.release = {customerLaunch: true, shakedown};
    });
    rmSync(join(root, MAINNET_RELEASE_AUTHORITY));
    const result = resultFor(validateTree(root), MAINNET_MANIFEST.split("/").pop() as string);
    assertRules(result, ["RA3"]);
    assert.match(result.errors[0], /no release-authority record/);
  });

  it("RA3: the rule is about every mainnet manifest, not only about a customer launch", () => {
    // The drill is a gate on Deploy (SPEC 10.5), not on launch day, so a manifest that has not opened to
    // customers is covered too: by the time this file exists the mainnet Safes already hold the roles.
    const root = copyFixture("valid-mainnet");
    rmSync(join(root, MAINNET_RELEASE_AUTHORITY));
    const result = resultFor(validateTree(root), MAINNET_MANIFEST.split("/").pop() as string);
    assertRules(result, ["RA3"]);
    assert.equal(readDoc(join(FIXTURES, "valid-mainnet"), MAINNET_MANIFEST).release, undefined);
  });

  it("RA3: a record labelled testnet with every custody fact false is rejected on the record", () => {
    const root = copyFixture("valid-mainnet");
    patch(root, MAINNET_MANIFEST, (doc) => {
      doc.release = {customerLaunch: true, shakedown};
    });
    patch(root, MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.environment = "testnet";
      doc.custody.separateSafes = false;
      doc.custody.recoveryDrill = {
        performed: false,
        date: null,
        chainId: null,
        safes: null,
        unavailableSignerPassed: false,
        compromisedSignerBlocked: false,
        signerReplacementPassed: false,
        treasuryWithdrawalProven: false,
        receiptRefs: [],
      };
    });
    const run = validateTree(root);
    assertRules(resultFor(run, "bsc-mainnet.json"), ["RA3"]);
    assert.equal(run.failed, 1, report(run)); // the manifest itself is covered, by this very record
  });

  it("RA3: a record naming a deployment that does not exist leaves the manifest uncovered", () => {
    const root = copyFixture("valid-mainnet");
    patch(root, MAINNET_MANIFEST, (doc) => {
      doc.release = {customerLaunch: true, shakedown};
    });
    patch(root, MAINNET_RELEASE_AUTHORITY, (doc) => {
      doc.deploymentId = "56:0xcccccccccccccccccccccccccccccccccccccccc";
    });
    const run = validateTree(root);
    assertRules(resultFor(run, MAINNET_MANIFEST.split("/").pop() as string), ["RA3"]);
    assertRules(resultFor(run, "bsc-mainnet.json"), []); // the record is well formed, it just covers nothing
  });

  it("the checked-in mainnet fixture is covered by its record and passes", () => {
    const run = validateTree(join(FIXTURES, "valid-mainnet"));
    assert.equal(run.failed, 0, report(run));
    assert.equal(run.results.length, 3);
  });

  it("RA3 does not reach local or testnet manifests", () => {
    for (const fixture of ["valid-local", "valid-plan"]) {
      const run = validateTree(join(FIXTURES, fixture));
      assert.equal(run.failed, 0, report(run));
      assert.ok(
        !run.results.some((r) => r.errors.some((e) => e.startsWith("[RA3]"))),
        `${fixture} reported RA3`,
      );
    }
  });
});

describe("chain identity behind a mainnet release", () => {
  it("CH4: a mainnet manifest with an unverified Multicall3 in the chain record is rejected", () => {
    const result = caseFor("valid-mainnet", "chains/56.json", (doc) => {
      doc.networkIdentity.multicall3 = null;
    });
    assertRules(result, ["CH4"]);
    assert.match(result.errors[0], /is a mainnet manifest on chain 56/);
  });

  it("CH4: a mainnet manifest with an unverified genesis hash is rejected", () => {
    const result = caseFor("valid-mainnet", "chains/56.json", (doc) => {
      doc.networkIdentity.genesisHash = null;
    });
    assertRules(result, ["CH4"]);
    assert.ok(result.errors[0].includes("genesisHash"));
  });

  it("CH4: a mainnet manifest with no chain record at all is rejected on the manifest", () => {
    const root = copyFixture("valid-mainnet");
    rmSync(join(root, "chains/56.json"));
    const result = resultFor(validateTree(root), MAINNET_MANIFEST.split("/").pop() as string);
    assertRules(result, ["CH4"]);
    assert.match(result.errors[0], /no chain record at config\/chains\/56\.json/);
  });

  // The rule is about mainnet manifests, not about chain records: config/chains/56.json is null today
  // and stays valid, because no mainnet deployment exists. Only the warning CH3w fires.
  it("a chain record with a null Multicall3 and no mainnet manifest only warns", () => {
    const root = copyFixture("valid-mainnet");
    rmSync(join(root, MAINNET_MANIFEST));
    rmSync(join(root, MAINNET_RELEASE_AUTHORITY));
    patch(root, "chains/56.json", (doc) => {
      doc.networkIdentity.multicall3 = null;
      doc.networkIdentity.genesisHash = null;
    });
    const result = resultFor(validateTree(root), "chains/56.json");
    assertRules(result, []);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^\[CH3w\]/);
  });
});

// ---------------------------------------------------------------------------

describe("the optional Automation upkeep (SPEC 10.3, ADR 039)", () => {
  const upkeepOf = (doc: Record<string, any>): Record<string, any> => ({
    address: "0xcccccccccccccccccccccccccccccccccccccccc",
    codeHash: "0x" + "11".repeat(32),
    deployBlock: doc.contracts.draw.deployBlock,
    deployTx: null,
    draw: doc.contracts.draw.address,
    registry: null,
    upkeepId: null,
  });

  it("a manifest with no upkeep record passes: the executor is optional", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, () => {});
    assertRules(result, []);
  });

  it("a deployed but unregistered upkeep passes", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.contracts.upkeep = upkeepOf(doc);
    });
    assertRules(result, []);
  });

  /** The chain 56 Chainlink Automation registry, as config/chains/56.json and the fixture record it. */
  const REGISTRY_56 = "0xdc21e279934ff6721cadfdd112dafb3261f09a2c";

  it("a registered upkeep with both registry and id passes", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.contracts.upkeep = {...upkeepOf(doc), registry: REGISTRY_56, upkeepId: "1234567890"};
    });
    assertRules(result, []);
  });

  it("D28: a registry that is not the one the chain record publishes is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.contracts.upkeep = {
        ...upkeepOf(doc),
        registry: "0xdddddddddddddddddddddddddddddddddddddddd",
        upkeepId: "1234567890",
      };
    });
    assertRules(result, ["D28"]);
    assert.match(result.errors[0], /publishes the Chainlink Automation registry/);
  });

  // Absent on either side is silence, not a failure: a chain record may predate the verified address.
  it("a registry is accepted when the chain record publishes none", () => {
    const root = copyFixture("valid-mainnet");
    patch(root, "chains/56.json", (doc) => {
      delete doc.automationRegistry;
    });
    patch(root, MAINNET_MANIFEST, (doc) => {
      doc.contracts.upkeep = {
        ...upkeepOf(doc),
        registry: "0xdddddddddddddddddddddddddddddddddddddddd",
        upkeepId: "1234567890",
      };
    });
    const result = resultFor(validateTree(root), MAINNET_MANIFEST.split("/").pop() as string);
    assertRules(result, []);
  });

  it("schema: an automationRegistry with no source is rejected", () => {
    const result = caseFor("valid-mainnet", "chains/56.json", (doc) => {
      delete doc.automationRegistry.source;
    });
    assert.ok(result.errors.length > 0, "the chain schema requires a source for a published registry");
  });

  it("schema: a checksummed automationRegistry address is rejected: addresses are compared lowercase", () => {
    const result = caseFor("valid-mainnet", "chains/56.json", (doc) => {
      doc.automationRegistry.address = "0xDc21E279934fF6721CaDfDD112DAfb3261f09A2C";
    });
    assert.ok(result.errors.length > 0, "the address pattern is lowercase hex");
  });

  it("D28: an upkeep bound to another Draw is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.contracts.upkeep = {...upkeepOf(doc), draw: "0x1111111111111111111111111111111111111111"};
    });
    assertRules(result, ["D28"]);
    assert.match(result.errors[0], /bound to another Draw/);
  });

  it("D28: an upkeep that is also a privileged role is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.contracts.upkeep = {...upkeepOf(doc), address: doc.ownership.feeAccount};
    });
    assertRules(result, ["D28"]);
    assert.match(result.errors[0], /holds no privileged role/);
  });

  it("D28: a registry without an upkeep id is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.contracts.upkeep = {...upkeepOf(doc), registry: "0xdddddddddddddddddddddddddddddddddddddddd"};
    });
    assertRules(result, ["D28"]);
    assert.match(result.errors[0], /registry without an upkeepId/);
  });

  it("schema: an unknown key under contracts.upkeep is rejected", () => {
    const result = caseFor("valid-mainnet", MAINNET_MANIFEST, (doc) => {
      doc.contracts.upkeep = {...upkeepOf(doc), owner: doc.ownership.finalOwner};
    });
    assertRules(result, ["schema"]);
  });
});

describe("the command line entry point", () => {
  it("exits 0 on a clean tree and prints one line per document", () => {
    const run = spawnSync(process.execPath, [VALIDATOR, join(FIXTURES, "valid-local")], {encoding: "utf8"});
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /2 document\(s\): 2 passed, 0 failed/);
    assert.match(run.stdout, /ok {4}.*chains[/\\]31337\.json/);
  });

  it("exits 1 when a document fails", () => {
    const root = copyFixture("valid-local");
    patch(root, LOCAL_MANIFEST, (doc) => {
      doc.deploymentId = "31337:0x1111111111111111111111111111111111111111";
    });
    const run = spawnSync(process.execPath, [VALIDATOR, root], {encoding: "utf8"});
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /FAIL/);
    assert.match(run.stdout, /\[D1\]/);
  });
});
