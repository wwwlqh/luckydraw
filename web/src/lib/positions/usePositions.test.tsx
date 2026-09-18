// The scan cursor of SPEC §10.1: what a second visit and a post-claim refresh read, and what they do not.
//
// `/entries` and `/wallet` share one log scan. It is memoized per (deployment, account, account epoch), so
// moving between the two pages must not rescan the deployment ("do not rescan genesis or every historical
// round on each page load") — and must not serve a frozen answer either, because an entry made after the
// first scan would then stay invisible until the wallet reconnected. Both halves are asserted here against
// the fake node: the exact `eth_getLogs` ranges, and the rows that come back.

import {type Address, luckyDrawAbi} from "@luckydraw/client";
import {act, screen, waitFor} from "@testing-library/react";
import {Interface} from "ethers";
import {useState} from "react";
import {beforeEach, describe, expect, it} from "vitest";
import {
  ACCOUNT,
  ConnectButton,
  connectTestWallet,
  fakeChain,
  positionFixture,
  renderSurface,
  roundFixture,
} from "../../components/wallet/testKit.tsx";
import {testManifest} from "../../test/harness.tsx";
import {clearPositionScanCache, usePositions} from "./usePositions.ts";

const drawInterface = new Interface(luckyDrawAbi);

/** The manifest's `chain.startBlock`: the lower bound every first scan starts at (SPEC §12). */
const START_BLOCK = testManifest().chain.startBlock;

function entryLog(roundId: bigint, buyer: Address, blockNumber: number) {
  const encoded = drawInterface.encodeEventLog("EntryBought", [
    roundId,
    buyer,
    1_000n,
    30n,
    970n,
    1_000n,
    1n,
    50_000_000_000n,
    1_760_000_000n,
  ]);
  return {
    address: testManifest().contracts.draw.address,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    blockHash: `0x${"22".repeat(32)}`,
    transactionHash: `0x${"33".repeat(32)}`,
    index: 0,
  };
}

/**
 * Round 1 was entered in block 11; round 2 is entered later, in a block only a second scan can reach.
 * The head starts at 2,000 so one 2,000-block window covers the whole history in a single `getLogs`.
 */
function scriptedChain() {
  return fakeChain({
    blockNumber: 2_000,
    rounds: {"1": roundFixture(1n), "2": roundFixture(2n)},
    positions: {"1": positionFixture(), "2": positionFixture()},
    getLogs: (filter) => {
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      const logs = [];
      if (from <= 11n && to >= 11n) logs.push(entryLog(1n, ACCOUNT, 11));
      if (from <= 2_050n && to >= 2_050n) logs.push(entryLog(2n, ACCOUNT, 2_050));
      return logs;
    },
  });
}

/** The rounds `usePositions` reports, and its refresh: one page's worth of the hook and nothing else. */
function Rows() {
  const positions = usePositions();
  return (
    <>
      <p data-testid="rows">{(positions.rows ?? []).map((row) => row.roundId.toString()).join(",")}</p>
      <p data-testid="status">{positions.status}</p>
      <button type="button" onClick={positions.refresh}>
        refresh-positions
      </button>
    </>
  );
}

/** The page the hook lives on, mounted and unmounted under a wallet session that stays connected. */
function Surface({controls}: {controls: {visit: (value: boolean) => void}}) {
  const [visible, setVisible] = useState(true);
  controls.visit = setVisible;
  return visible ? <Rows /> : <p>elsewhere</p>;
}

function rowsText(): string {
  return screen.getByTestId("rows").textContent ?? "";
}

async function mount() {
  const chain = scriptedChain();
  const controls = {visit: (_: boolean) => undefined};
  renderSurface(
    <>
      <ConnectButton />
      <Surface controls={controls} />
    </>,
    chain.base,
  );
  await connectTestWallet();
  await waitFor(() => expect(rowsText()).toBe("1"));
  return {chain, controls};
}

function ranges(chain: ReturnType<typeof fakeChain>): [string, string][] {
  return chain.logCalls.map((entry) => [entry.fromBlock, entry.toBlock]);
}

describe("the memoized log scan", () => {
  beforeEach(() => clearPositionScanCache());

  it("continues from the cached cursor on a second visit and shows the round entered since", async () => {
    const {chain, controls} = await mount();
    // The whole deployment in one window: blocks 10 to the head at 2,000.
    expect(ranges(chain)).toEqual([["0xa", "0x7d0"]]);

    // Leave the page, mine 100 blocks (one of which holds this account's entry into round 2), come back.
    await act(async () => {
      controls.visit(false);
    });
    chain.node.advance(100);
    await act(async () => {
      controls.visit(true);
    });

    // `resolvePositions` sorts the newest round first, so the round entered since leads the list.
    await waitFor(() => expect(rowsText()).toBe("2,1"));
    // Exactly one further read, and it starts at the block after the cached cursor, not at `startBlock`.
    expect(ranges(chain)).toEqual([
      ["0xa", "0x7d0"],
      ["0x7d1", "0x834"],
    ]);
    expect(START_BLOCK).toBe(10n);
  });

  it("reads no logs at all on a second visit when no block has been mined since", async () => {
    const {chain, controls} = await mount();
    await act(async () => {
      controls.visit(false);
    });
    await act(async () => {
      controls.visit(true);
    });

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));
    expect(rowsText()).toBe("1");
    expect(chain.logCalls).toHaveLength(1);
  });

  it("does not rescan from the start block when a claim refreshes the positions", async () => {
    const {chain} = await mount();
    const before = chain.logCalls.length;

    await act(async () => {
      screen.getByText("refresh-positions").click();
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));

    // The head has not moved, so the refresh re-reads the positions and asks the node for no logs at all;
    // whatever it does read, it never starts over at `startBlock`.
    expect(chain.logCalls.slice(before).map((entry) => entry.fromBlock)).not.toContain("0xa");
    expect(rowsText()).toBe("1");
  });
});

// SPEC §10.1 again, for the failure case: an incomplete scan used not to be memoized at all, so the very
// first window failing (which is what a rate-limited BSC data seed does) left "0 of 23,802 blocks" on screen
// and made "Scan again" start over at `startBlock` every time. A scan never moves its cursor past a window
// it could not read, so its progress is contiguous and safe to resume from.
describe("a scan that stopped short", () => {
  beforeEach(() => clearPositionScanCache());

  function WindowedRows() {
    const positions = usePositions({windowBlocks: 1_000n});
    return (
      <>
        <p data-testid="status">{positions.status}</p>
        <p data-testid="scannedTo">{(positions.scan?.scannedTo ?? -1n).toString()}</p>
        <button type="button" onClick={positions.refresh}>
          refresh-positions
        </button>
      </>
    );
  }

  it("resumes from its cursor when the scan re-runs instead of restarting at the start block", async () => {
    let failing = true;
    const chain = fakeChain({
      blockNumber: 5_000,
      rounds: {"1": roundFixture(1n)},
      positions: {"1": positionFixture()},
      getLogs: (filter) => {
        // The first two windows answer; everything past block 2,009 refuses until `failing` is cleared.
        if (failing && BigInt(filter.fromBlock) > 2_009n) throw new Error("socket hang up");
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);
        return from <= 11n && to >= 11n ? [entryLog(1n, ACCOUNT, 11)] : [];
      },
    });
    renderSurface(
      <>
        <ConnectButton />
        <WindowedRows />
      </>,
      chain.base,
    );
    await connectTestWallet();

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
    // Two whole windows were read before the refusal, and that progress is what the cursor records.
    expect(screen.getByTestId("scannedTo").textContent).toBe("2009");

    failing = false;
    const before = chain.logCalls.length;
    await act(async () => {
      screen.getByText("refresh-positions").click();
    });
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));

    const resumed = chain.logCalls.slice(before);
    // `refresh()` is a resume: the first read after it starts at 2,010, and `startBlock` is never re-read.
    expect(resumed[0]?.fromBlock).toBe("0x7da");
    expect(resumed.map((entry) => entry.fromBlock)).not.toContain("0xa");
    expect(screen.getByTestId("scannedTo").textContent).toBe("5000");
  });
});

// The pruning boundary is the one thing a cursor carries that a resume can never unlearn: `mergeBoundary`
// only ever raises it, because a resumed run reads the tail and never revisits the blocks it names. That is
// right while the endpoint stays the same and wrong the moment the operator points the app at an archive
// RPC, so the explicit retry is a restart rather than a resume. All three halves are pinned here.
describe("the pruning boundary across scans", () => {
  beforeEach(() => clearPositionScanCache());

  /** The pruning height the fake node enforces; the tests move it between scans. */
  let prunedBelow = 0n;

  function prunedChain(blockNumber: number) {
    return fakeChain({
      blockNumber,
      rounds: {"1": roundFixture(1n)},
      positions: {"1": positionFixture()},
      getLogs: (filter) => {
        if (BigInt(filter.fromBlock) < prunedBelow) {
          throw {
            code: -32701,
            message: "History has been pruned for this block. To remove restrictions, order a dedicated ",
          };
        }
        return [];
      },
    });
  }

  function BoundaryRows() {
    const positions = usePositions({windowBlocks: 1_000n});
    return (
      <>
        <p data-testid="status">{positions.status}</p>
        <p data-testid="boundary">{(positions.historyUnavailableBelow ?? -1n).toString()}</p>
        <p data-testid="scannedTo">{(positions.scan?.scannedTo ?? -1n).toString()}</p>
        <button type="button" onClick={positions.refresh}>
          refresh-positions
        </button>
        <button type="button" onClick={positions.rescan}>
          rescan-positions
        </button>
      </>
    );
  }

  function boundary(): string {
    return screen.getByTestId("boundary").textContent ?? "";
  }

  async function mountBoundary(blockNumber: number) {
    const chain = prunedChain(blockNumber);
    renderSurface(
      <>
        <ConnectButton />
        <BoundaryRows />
      </>,
      chain.base,
    );
    await connectTestWallet();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("ready"));
    return chain;
  }

  it("keeps a boundary an earlier run recorded when a later run only reads the tail", async () => {
    prunedBelow = 2_010n;
    const chain = await mountBoundary(5_000);
    expect(boundary()).toBe("2010");

    // Blocks are mined and the page re-renders: a resume, reading only above the cached cursor. Nothing in
    // that tail can say anything about the pruned prefix, so the label must survive it.
    chain.node.advance(100);
    const before = chain.logCalls.length;
    await act(async () => {
      screen.getByText("refresh-positions").click();
    });
    await waitFor(() => expect(screen.getByTestId("scannedTo").textContent).toBe("5100"));

    expect(chain.logCalls.slice(before).map((entry) => entry.fromBlock)).toEqual(["0x1389"]);
    expect(boundary()).toBe("2010");
  });

  it("raises the boundary when the node has pruned further by the next scan", async () => {
    prunedBelow = 2_010n;
    const chain = await mountBoundary(5_000);
    expect(boundary()).toBe("2010");

    // Hours later the rolling retention window has moved past the blocks this scan already read.
    prunedBelow = 8_000n;
    chain.node.advance(4_000);
    await act(async () => {
      screen.getByText("refresh-positions").click();
    });
    await waitFor(() => expect(screen.getByTestId("scannedTo").textContent).toBe("9000"));

    // The resume starts at 5,001 and is refused up to 8,000, so the first block still served is 8,001.
    expect(boundary()).toBe("8001");
  });

  it("clears the boundary on an explicit rescan and reads the span again from the start block", async () => {
    prunedBelow = 2_010n;
    const chain = await mountBoundary(5_000);
    expect(boundary()).toBe("2010");

    // The operator switches the deployment to an archive-capable RPC. A resume would never find out; only
    // the reader's own retry, which drops the cached cursor, can.
    prunedBelow = 0n;
    const before = chain.logCalls.length;
    await act(async () => {
      screen.getByText("rescan-positions").click();
    });
    await waitFor(() => expect(boundary()).toBe("-1"));

    // It starts over at `startBlock`, which is exactly what `refresh()` must never do.
    expect(chain.logCalls.slice(before)[0]?.fromBlock).toBe("0xa");
    expect(screen.getByTestId("status").textContent).toBe("ready");
  });
});
