// Tests for scripts/check_chain_record.ts, run with Node's built-in runner:
//     node --test scripts/check_chain_record.test.ts
//
// Every case drives the check through an injected `RpcFn`: no socket is opened and no recorded mainnet
// response appears anywhere in this file. The node fake is built from a small state record, and the
// `Result[]` encoder below is written independently of the script's decoder, so a shared mistake in the two
// would have to be made twice.
//
// Two golden values anchor the hand-rolled codec to something outside this repository's own opinion:
//
//   - the selectors, against the method identifiers Foundry generates for forge-std's `IMulticall3`
//     (contracts/out/IMulticall3.sol/IMulticall3.json "methodIdentifiers"), and
//   - the `aggregate3` calldata, against `cast calldata "aggregate3((address,bool,bytes)[])" ...`.
//
// The `Result[]` golden is the answer a Solidity Multicall3 surface compiled with solc 0.8.28 gave over
// `eth_call` on a local anvil, captured while building this script.

import assert from "node:assert/strict";
import {join} from "node:path";
import {describe, it} from "node:test";
import {
  AGGREGATE3,
  type ChainRecordIdentity,
  type CheckResult,
  checkChainRecord,
  decodeAggregate3,
  encodeAggregate3,
  GET_BLOCK_NUMBER,
  GET_CHAIN_ID,
  keccak256,
  loadRecord,
  parseArgs,
  type RpcFn,
  redactUrls,
  report,
  selectorOf,
  USAGE,
  UsageError,
} from "./check_chain_record.ts";

const SCRIPT_DIR: string = import.meta.dirname;
const REPO_ROOT: string = join(SCRIPT_DIR, "..");

/** A plausible Multicall3 address. It is an argument everywhere, never a constant the script believes in. */
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111";
const GENESIS = `0x${"ab".repeat(32)}`;
const OTHER_GENESIS = `0x${"cd".repeat(32)}`;
const TODAY = "2026-09-16";

// ---------------------------------------------------------------------------
// A fake node
// ---------------------------------------------------------------------------

function pad(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function uint256(value: bigint): string {
  return `0x${pad(value)}`;
}

/** `Result[] (bool success, bytes returnData)`, encoded here rather than by the code under test. */
function encodeResults(items: readonly {success: boolean; returnData: string}[]): string {
  const bodies = items.map((item) => {
    const data = item.returnData.slice(2);
    const padding = "0".repeat((64 - (data.length % 64)) % 64);
    return pad(item.success ? 1n : 0n) + pad(0x40n) + pad(BigInt(data.length / 2)) + data + padding;
  });
  let cursor = 32 * bodies.length;
  const offsets: string[] = [];
  for (const body of bodies) {
    offsets.push(pad(BigInt(cursor)));
    cursor += body.length / 2;
  }
  return `0x${pad(0x20n)}${pad(BigInt(items.length))}${offsets.join("")}${bodies.join("")}`;
}

type NodeState = {
  chainId: bigint;
  /** Null makes the node answer `eth_getBlockByNumber("0x0")` with null, as a pruned node might. */
  genesisHash: string | null;
  /** "0x" means no contract at the address. */
  code: string;
  head: bigint;
  /** The head at the second `eth_blockNumber`. Defaults to `head`. */
  headAfter?: bigint;
  /** What `getBlockNumber()` answers. Defaults to `head`. */
  blockNumberAnswer?: bigint;
  /** What `getChainId()` answers through `aggregate3`. Defaults to `chainId`. */
  chainIdAnswer?: bigint;
  /** Marks the first `aggregate3` item as failed. */
  aggregateFails?: boolean;
  /** Replaces the whole `Result[]` `aggregate3` answers with, including an empty one. */
  aggregateResults?: readonly {success: boolean; returnData: string}[];
  /** Method name to reject, with this message. */
  throwOn?: {method: string; message: string};
};

function fakeNode(state: NodeState): {rpc: RpcFn; methods: string[]} {
  const methods: string[] = [];
  let blockNumberReads = 0;
  const rpc: RpcFn = (method, params) => {
    methods.push(method);
    if (state.throwOn !== undefined && state.throwOn.method === method) {
      return Promise.reject(new Error(state.throwOn.message));
    }
    switch (method) {
      case "eth_chainId":
        return Promise.resolve(`0x${state.chainId.toString(16)}`);
      case "eth_blockNumber": {
        blockNumberReads += 1;
        const value = blockNumberReads === 1 ? state.head : (state.headAfter ?? state.head);
        return Promise.resolve(`0x${value.toString(16)}`);
      }
      case "eth_getBlockByNumber":
        return Promise.resolve(state.genesisHash === null ? null : {hash: state.genesisHash});
      case "eth_getCode":
        return Promise.resolve(state.code);
      case "eth_call": {
        const call = params[0] as {to: string; data: string};
        if (call.data.startsWith(GET_BLOCK_NUMBER)) {
          return Promise.resolve(uint256(state.blockNumberAnswer ?? state.head));
        }
        if (call.data.startsWith(AGGREGATE3)) {
          return Promise.resolve(
            encodeResults(
              state.aggregateResults ?? [
                {
                  success: state.aggregateFails !== true,
                  returnData: uint256(state.blockNumberAnswer ?? state.head),
                },
                {success: true, returnData: uint256(state.chainIdAnswer ?? state.chainId)},
              ],
            ),
          );
        }
        return Promise.reject(new Error(`unexpected eth_call ${call.data.slice(0, 10)}`));
      }
      default:
        return Promise.reject(new Error(`unexpected method ${method}`));
    }
  };
  return {rpc, methods};
}

const HEALTHY: NodeState = {
  chainId: 56n,
  genesisHash: GENESIS,
  code: "0x60806040",
  head: 1_000n,
  headAfter: 1_001n,
};

const RECORDED: ChainRecordIdentity = {chainId: 56, genesisHash: GENESIS, multicall3: MULTICALL3};

function run(
  state: NodeState,
  record: ChainRecordIdentity | null,
  chainId = 56n,
  multicall3 = MULTICALL3,
): Promise<CheckResult> {
  return checkChainRecord({
    chainId,
    multicall3,
    rpc: fakeNode(state).rpc,
    record,
    recordPath: `config/chains/${chainId}.json`,
    today: TODAY,
  });
}

/** The findings of one severity, as `code: message` lines. */
function codes(result: CheckResult, level: "ok" | "note" | "error"): string[] {
  return result.findings.filter((finding) => finding.level === level).map((finding) => finding.code);
}

function messageFor(result: CheckResult, code: string): string {
  const finding = result.findings.find((entry) => entry.code === code);
  assert.ok(finding !== undefined, `no finding ${code} in ${JSON.stringify(codes(result, "error"))}`);
  return finding.message;
}

// ---------------------------------------------------------------------------

describe("keccak256 and the derived selectors", () => {
  it("matches the two published Keccak-256 known answers", () => {
    assert.equal(
      keccak256(new Uint8Array(0)),
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    assert.equal(
      keccak256(new TextEncoder().encode("abc")),
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("derives the three selectors Foundry reports for IMulticall3", () => {
    // contracts/out/IMulticall3.sol/IMulticall3.json, "methodIdentifiers".
    assert.equal(GET_BLOCK_NUMBER, "0x42cbb15c");
    assert.equal(GET_CHAIN_ID, "0x3408e470");
    assert.equal(AGGREGATE3, "0x82ad56cb");
    assert.equal(selectorOf("aggregate((address,bytes)[])"), "0x252dba42");
    assert.equal(selectorOf("getBlockHash(uint256)"), "0xee82ac5e");
  });

  it("hashes a message longer than the 136-byte rate", () => {
    // One absorb boundary and one past it; both must differ from each other and from the empty hash.
    const short = keccak256(new Uint8Array(135).fill(7));
    const exact = keccak256(new Uint8Array(136).fill(7));
    const long = keccak256(new Uint8Array(137).fill(7));
    assert.equal(new Set([short, exact, long]).size, 3);
    for (const digest of [short, exact, long]) assert.match(digest, /^0x[0-9a-f]{64}$/);
  });
});

describe("aggregate3 coding", () => {
  it("encodes exactly what cast encodes", () => {
    // cast calldata "aggregate3((address,bool,bytes)[])" \
    //   '[(0xca11...ca11,true,0x42cbb15c),(0xca11...ca11,true,0x3408e470)]'
    const expected =
      "0x82ad56cb" +
      `${pad(0x20n)}${pad(2n)}${pad(0x40n)}${pad(0xe0n)}` +
      `${pad(BigInt(MULTICALL3))}${pad(1n)}${pad(0x60n)}${pad(4n)}42cbb15c${"0".repeat(56)}` +
      `${pad(BigInt(MULTICALL3))}${pad(1n)}${pad(0x60n)}${pad(4n)}3408e470${"0".repeat(56)}`;
    assert.equal(
      encodeAggregate3([
        {target: MULTICALL3, callData: GET_BLOCK_NUMBER},
        {target: MULTICALL3, callData: GET_CHAIN_ID},
      ]),
      expected,
    );
  });

  it("decodes the Result[] a real EVM returned", () => {
    // Captured from `eth_call` on anvil against a solc 0.8.28 Multicall3 surface: block 0, chain 31337.
    const raw =
      "0x0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000002" +
      "0000000000000000000000000000000000000000000000000000000000000040" +
      "00000000000000000000000000000000000000000000000000000000000000c0" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0000000000000000000000000000000000000000000000000000000000000040" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000000" +
      "0000000000000000000000000000000000000000000000000000000000000001" +
      "0000000000000000000000000000000000000000000000000000000000000040" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000007a69";
    assert.deepEqual(decodeAggregate3(raw), [
      {success: true, returnData: uint256(0n)},
      {success: true, returnData: uint256(31_337n)},
    ]);
    // The test's own encoder agrees with the chain's, so the fake node speaks the real shape.
    assert.equal(
      encodeResults([
        {success: true, returnData: uint256(0n)},
        {success: true, returnData: uint256(31_337n)},
      ]),
      raw,
    );
  });

  it("refuses a truncated response instead of inventing an item", () => {
    assert.throws(() => decodeAggregate3(`0x${pad(0x20n)}${pad(2n)}${pad(0x40n)}`), /ends inside word/);
  });
});

describe("the chain record check", () => {
  it("passes when the chain and the record agree", async () => {
    const result = await run(HEALTHY, RECORDED);
    assert.equal(result.ok, true);
    assert.deepEqual(codes(result, "error"), []);
    assert.deepEqual(codes(result, "ok"), ["C1", "C2", "C3", "C4", "C5", "C6", "C8", "C9"]);
    assert.equal(result.observed.chainId, 56n);
    assert.equal(result.observed.genesisHash, GENESIS);
    assert.equal(result.observed.codeSize, 4);
    assert.equal(result.observed.aggregateChainId, 56n);
    // The two field names are the ones rule CH4 in scripts/validate_config.ts looks for, and the object is
    // a drop-in replacement for the record's whole `networkIdentity`, so the paste cannot go half-done.
    assert.equal(
      result.fragment,
      [
        '  "networkIdentity": {',
        `    "genesisHash": "${GENESIS}",`,
        `    "multicall3": "${MULTICALL3}",`,
        `    "source": { "url": null, "date": "${TODAY}" }`,
        "  }",
      ].join("\n"),
    );
    const printed = report(result, "config/chains/56.json");
    assert.match(printed, /Paste into config\/chains\/56\.json/);
    assert.match(printed, /This script does not write the file/);
  });

  it("accepts a mixed-case --multicall3 and compares it lowercase", async () => {
    const result = await run(HEALTHY, RECORDED, 56n, "0xCA11bDe05977b3631167028862bE2a173976CA11");
    assert.deepEqual(codes(result, "error"), []);
    assert.match(String(result.fragment), new RegExp(`"multicall3": "${MULTICALL3}"`));
  });

  it("reports a Multicall3 that disagrees with the record, and withholds the fragment", async () => {
    const result = await run(HEALTHY, {...RECORDED, multicall3: OTHER_ADDRESS});
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, "error"), ["C9"]);
    assert.match(messageFor(result, "C9"), /is 0x1111.* but the chain says 0xca11/);
    assert.match(messageFor(result, "C9"), /find out which is wrong/);
    assert.match(report(result, "config/chains/56.json"), /fragment is withheld/);
  });

  it("reports a genesis hash that disagrees with the record", async () => {
    const result = await run({...HEALTHY, genesisHash: OTHER_GENESIS}, RECORDED);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, "error"), ["C8"]);
    assert.match(messageFor(result, "C8"), /networkIdentity\.genesisHash is 0xabab/);
  });

  it("fails when there is no code at the address, and makes no Multicall3 call", async () => {
    const node = fakeNode({...HEALTHY, code: "0x"});
    const result = await checkChainRecord({
      chainId: 56n,
      multicall3: MULTICALL3,
      rpc: node.rpc,
      record: {chainId: 56, genesisHash: GENESIS, multicall3: null},
      recordPath: "config/chains/56.json",
      today: TODAY,
    });
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, "error"), ["C3"]);
    assert.match(messageFor(result, "C3"), /there is no code at 0xca11.*do not record it/s);
    assert.deepEqual(node.methods, ["eth_chainId", "eth_getBlockByNumber", "eth_getCode"]);
    assert.equal(result.fragment, null, "nothing to paste when the address holds no contract");
    assert.match(report(result, "config/chains/56.json"), /No fragment/);
  });

  it("fails when the endpoint is a different chain", async () => {
    const result = await run({...HEALTHY, chainId: 97n, chainIdAnswer: 97n}, RECORDED);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, "error"), ["C1", "C6"]);
    assert.match(messageFor(result, "C1"), /eth_chainId is 97 but --chain-id is 56/);
    assert.match(messageFor(result, "C6"), /getChainId\(\) is 97 but --chain-id is 56/);
  });

  it("fails when the contract answers a block number outside the head window", async () => {
    const result = await run({...HEALTHY, blockNumberAnswer: 500n}, RECORDED, 56n);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, "error"), ["C4", "C5"]);
    assert.match(messageFor(result, "C4"), /is 500 but eth_blockNumber moved 1000 -> 1001/);
  });

  it("tolerates a head that advances during the read", async () => {
    const result = await run({...HEALTHY, headAfter: 1_004n, blockNumberAnswer: 1_003n}, RECORDED);
    assert.deepEqual(codes(result, "error"), []);
  });

  it("fails when aggregate3 reports an item failure", async () => {
    const result = await run({...HEALTHY, aggregateFails: true}, RECORDED);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, "error"), ["C5"]);
    assert.match(messageFor(result, "C5"), /does not behave like Multicall3/);
  });

  it("fails when aggregate3 answers a well-formed but empty Result[]", async () => {
    // A `Result[]` of length 0 decodes perfectly; it is simply not an answer to the two calls that were
    // asked. The empty case has to be told apart from a decode failure, because a decoder that starts its
    // item list empty cannot distinguish "the contract answered nothing" from "the response was garbage" -
    // and either way a silent pass would print the fragment as if Multicall3 had confirmed the chain.
    const result = await run({...HEALTHY, aggregateResults: []}, RECORDED);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, "error"), ["C5"]);
    assert.match(messageFor(result, "C5"), /aggregate3 returned 0 results for 2 calls/);
    assert.equal(result.observed.aggregateBlockNumber, null);
    assert.equal(result.observed.aggregateChainId, null);
    assert.match(report(result, "config/chains/56.json"), /fragment is withheld/);
  });

  it("fails when aggregate3 answers a Result[] of the wrong length", async () => {
    const result = await run(
      {...HEALTHY, aggregateResults: [{success: true, returnData: uint256(1_000n)}]},
      RECORDED,
    );
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, "error"), ["C5"]);
    assert.match(messageFor(result, "C5"), /aggregate3 returned 1 results for 2 calls/);
  });

  it("fails when the node cannot produce block 0", async () => {
    const result = await run({...HEALTHY, genesisHash: null}, RECORDED);
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, "error"), ["C2"]);
    assert.equal(result.fragment, null);
  });

  it("notes, rather than fails, a record whose fields are still null", async () => {
    const result = await run(HEALTHY, {chainId: 56, genesisHash: null, multicall3: null});
    assert.equal(result.ok, true);
    assert.deepEqual(codes(result, "note"), ["C8", "C9"]);
    assert.match(messageFor(result, "C9"), /is null; paste the fragment below/);
  });

  it("fails when the record is a different chain than the flag", async () => {
    const result = await run(HEALTHY, {...RECORDED, chainId: 97});
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result, "error"), ["C7"]);
  });

  it("notes an absent record and still prints the fragment", async () => {
    const result = await run(HEALTHY, null);
    assert.equal(result.ok, true);
    assert.deepEqual(codes(result, "note"), ["C7"]);
    assert.match(String(result.fragment), /"genesisHash"/);
  });

  it("refuses an argument that is not an address before touching the node", async () => {
    const node = fakeNode(HEALTHY);
    for (const candidate of ["not-an-address", `0x${"0".repeat(40)}`]) {
      const result = await checkChainRecord({
        chainId: 56n,
        multicall3: candidate,
        rpc: node.rpc,
        record: RECORDED,
        recordPath: "config/chains/56.json",
      });
      assert.equal(result.ok, false);
      assert.deepEqual(codes(result, "error"), ["C0"]);
    }
    assert.deepEqual(node.methods, [], "a bad argument costs no request");
  });

  it("keeps the endpoint out of a provider error message", async () => {
    const secret = "https://bsc.example.invalid/v1/THE-OPERATORS-KEY";
    const result = await run(
      {...HEALTHY, throwOn: {method: "eth_chainId", message: `connect ECONNREFUSED ${secret}`}},
      RECORDED,
    );
    const printed = report(result, "config/chains/56.json");
    assert.equal(printed.includes("THE-OPERATORS-KEY"), false);
    assert.equal(printed.includes("bsc.example.invalid"), false);
    assert.match(messageFor(result, "C1"), /connect ECONNREFUSED <rpc>/);
    assert.equal(redactUrls(`see ${secret} and http://plain.invalid/x`), "see <rpc> and <rpc>");
  });
});

describe("the command line", () => {
  it("parses the three required flags", () => {
    const args = parseArgs([
      "--rpc-url",
      "https://node.invalid/rpc",
      "--chain-id",
      "56",
      "--multicall3",
      MULTICALL3.toUpperCase().replace("0X", "0x"),
      "--head-slack",
      "3",
    ]);
    assert.equal(args.chainId, 56n);
    assert.equal(args.headSlack, 3n);
    assert.match(args.configRoot, /config$/);
  });

  it("refuses to write the record", () => {
    for (const flag of ["--write", "--fix", "--apply"]) {
      assert.throws(
        () => parseArgs(["--rpc-url", "https://n.invalid", "--chain-id", "56", flag, "x"]),
        (error: unknown) => error instanceof UsageError && /read-only/.test(error.message),
        `${flag} must be refused`,
      );
    }
  });

  it("rejects a missing or malformed flag", () => {
    const cases: [string[], RegExp][] = [
      [[], /--rpc-url is required/],
      [["--rpc-url", "ftp://node.invalid"], /http\(s\) URL/],
      [["--rpc-url", "https://n.invalid", "--chain-id", "0x38"], /positive integer/],
      [["--rpc-url", "https://n.invalid", "--chain-id", "56"], /--multicall3 is required/],
      [["--rpc-url", "https://n.invalid", "--chain-id", "56", "--multicall3", "0xdead"], /20-byte address/],
      [["positional"], /unexpected argument/],
    ];
    for (const [argv, expected] of cases) {
      assert.throws(() => parseArgs(argv), expected, argv.join(" "));
    }
    assert.match(USAGE, /--multicall3 <address>/);
  });
});

describe("loadRecord", () => {
  it("reads the two fields from the repository's own mainnet record", () => {
    const record = loadRecord(join(REPO_ROOT, "config", "chains", "56.json"));
    assert.ok(record !== null, "config/chains/56.json must exist");
    assert.equal(record.chainId, 56);
    for (const value of [record.genesisHash, record.multicall3]) {
      assert.ok(value === null || /^0x[0-9a-f]+$/.test(value), `unexpected field value ${value}`);
    }
  });

  it("returns null for a record that does not exist", () => {
    assert.equal(loadRecord(join(REPO_ROOT, "config", "chains", "999999.json")), null);
  });
});
