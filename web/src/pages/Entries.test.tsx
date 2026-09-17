// `/entries` end to end against a fake node: the paged log scan, the chain confirming or rejecting each
// candidate, the five tabs of SPEC §9.4, and the account-scoped cache of §9.2.

import {type Address, catalogEntryFor, luckyDrawAbi, State} from "@luckydraw/client";
import {fireEvent} from "@testing-library/dom";
import {act, screen, waitFor} from "@testing-library/react";
import {Interface} from "ethers";
import {beforeEach, describe, expect, it} from "vitest";
import {
  ACCOUNT,
  ConnectButton,
  connectTestWallet,
  fakeChain,
  positionFixture,
  renderSurface,
  roundFixture,
} from "../components/wallet/testKit.tsx";
import {LogScanRateLimitError} from "../lib/positions/discovery.ts";
import {clearPositionScanCache} from "../lib/positions/usePositions.ts";
import {WALLET_TEXT_MAX} from "../lib/wallet/errors.ts";
import {en} from "../strings/en.ts";
import {walletEn} from "../strings/wallet.ts";
import {testManifest} from "../test/harness.tsx";
import {EntriesPage, scanFailureView} from "./Entries.tsx";

const SECOND_ACCOUNT = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address;
const drawInterface = new Interface(luckyDrawAbi);

function entryLog(emitter: string, roundId: bigint, buyer: Address, blockNumber: number) {
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
    address: emitter,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber,
    blockHash: `0x${"22".repeat(32)}`,
    transactionHash: `0x${"33".repeat(32)}`,
    index: 0,
  };
}

/** Rounds 1 to 6, one per §6.2 state, plus round 7 whose log has no position behind it. */
function scriptedChain(options: {logsFor?: Address; refundCredited?: boolean} = {}) {
  const buyer = options.logsFor ?? ACCOUNT;
  const rounds = {
    "1": roundFixture(1n, {state: State.Open}),
    "2": roundFixture(2n, {state: State.Drawing}),
    "3": roundFixture(3n, {state: State.Settled, winner: ACCOUNT}),
    "4": roundFixture(4n, {state: State.Settled, winner: SECOND_ACCOUNT}),
    "5": roundFixture(5n, {state: State.Refunding}),
    "6": roundFixture(6n, {state: State.Void}),
    "7": roundFixture(7n, {state: State.Open}),
  };
  const positions = {
    "1": positionFixture(),
    "2": positionFixture(),
    "3": positionFixture(),
    "4": positionFixture(),
    "5": positionFixture({refunded: options.refundCredited ?? false}),
    "6": positionFixture(),
    // Round 7 has a log but no position: the chain is the answer, not the log (SPEC §10.1).
    "7": positionFixture({gross: 0n}),
  };
  const drawAddress = testManifest().contracts.draw.address;
  return fakeChain({
    blockNumber: 5_000,
    rounds,
    positions,
    getLogs: (filter) => {
      // Every entry sits in the first window, so the later windows prove the paging happened.
      if (BigInt(filter.fromBlock) !== 10n) return [];
      return [1n, 2n, 3n, 4n, 5n, 6n, 7n].map((id) => entryLog(drawAddress, id, buyer, 11));
    },
  });
}

async function mount(chain: ReturnType<typeof fakeChain>) {
  renderSurface(
    <>
      <ConnectButton />
      <EntriesPage />
    </>,
    chain.base,
  );
  const wallet = await connectTestWallet();
  await waitFor(() =>
    expect(screen.getByRole("tab", {name: /Active/})).toHaveAttribute("aria-current", "page"),
  );
  return wallet;
}

function tab(label: string) {
  return screen.getByRole("tab", {name: new RegExp(label)});
}

describe("EntriesPage", () => {
  beforeEach(() => clearPositionScanCache());

  it("pages the log window from the manifest start block to the head", async () => {
    const chain = scriptedChain();
    await mount(chain);
    await waitFor(() => expect(chain.logCalls.length).toBeGreaterThan(1));

    // startBlock 10, head 5,000, default window 2,000 blocks (SPEC §10.1).
    expect(chain.logCalls.map((entry) => [entry.fromBlock, entry.toBlock])).toEqual([
      ["0xa", "0x7d9"],
      ["0x7da", "0xfa9"],
      ["0xfaa", "0x1388"],
    ]);
  });

  it("drops a candidate the chain says this account does not hold", async () => {
    const chain = scriptedChain();
    await mount(chain);
    await waitFor(() => expect(tab("Active")).toHaveTextContent("Active (1)"));

    // Round 7's log was found and its position read back as zero, so it is in no tab at all.
    expect(screen.queryByText("Round 7")).toBeNull();
    const counts = ["Active (1)", "Awaiting result (1)", "Won (1)", "Refunds (1)", "Past (3)"];
    for (const text of counts) expect(screen.getByRole("tab", {name: text})).toBeInTheDocument();
  });

  it("classifies the §6.2 states into the five tabs and never marks an unsettled round lost", async () => {
    const chain = scriptedChain();
    await mount(chain);
    await waitFor(() => expect(tab("Active")).toHaveTextContent("Active (1)"));

    expect(screen.getByText("Round 1")).toBeInTheDocument();
    expect(screen.getByText(walletEn.entries.stateLabels.Open)).toBeInTheDocument();

    fireEvent.click(tab("Awaiting result"));
    expect(screen.getByText("Round 2")).toBeInTheDocument();
    expect(screen.getByText(walletEn.entries.stateLabels.Drawing)).toBeInTheDocument();
    // An unsettled round never says the entry was not drawn.
    expect(screen.queryByText(walletEn.entries.rowNotSelected)).toBeNull();
    expect(screen.getByText(walletEn.entries.rowUnsettled)).toBeInTheDocument();

    fireEvent.click(tab("Won"));
    expect(screen.getByText("Round 3")).toBeInTheDocument();
    expect(screen.getByText(walletEn.entries.rowPrize)).toBeInTheDocument();

    fireEvent.click(tab("Refunds"));
    expect(screen.getByText("Round 5")).toBeInTheDocument();
    expect(screen.getByRole("button", {name: /Claim the refund for round 5/})).toBeInTheDocument();

    fireEvent.click(tab("Past"));
    // Settled-won, settled-not-selected and Void: three concluded rounds.
    expect(screen.getByText("Round 3")).toBeInTheDocument();
    expect(screen.getByText("Round 4")).toBeInTheDocument();
    expect(screen.getByText("Round 6")).toBeInTheDocument();
    expect(screen.getByText(walletEn.entries.rowNotSelected)).toBeInTheDocument();
  });

  it("clears the scan cache and rescans when the account changes", async () => {
    const chain = scriptedChain();
    const wallet = await mount(chain);
    await waitFor(() => expect(tab("Active")).toHaveTextContent("Active (1)"));
    const firstScan = chain.logCalls.length;

    await act(async () => {
      wallet.setAccounts([SECOND_ACCOUNT]);
    });

    // A new account epoch drops every cached scan and starts a fresh one for the new address.
    await waitFor(() => expect(chain.logCalls.length).toBeGreaterThan(firstScan));
    await waitFor(() => expect(tab("Active")).toHaveTextContent("Active (0)"));
  });

  it("offers a route to the money on every tab a credited row appears on, and only there", async () => {
    const chain = scriptedChain({refundCredited: true});
    await mount(chain);
    await waitFor(() => expect(tab("Won")).toHaveTextContent("Won (1)"));

    // Won: the prize amount and a link to the balance it landed in.
    fireEvent.click(tab("Won"));
    expect(screen.getByText(walletEn.entries.rowPrizeAmount)).toBeInTheDocument();
    expect(screen.getAllByRole("link", {name: walletEn.entries.rowGoToWallet})).toHaveLength(1);

    // Past holds the same won round, the credited refund and two rows that credited nothing.
    fireEvent.click(tab("Past"));
    expect(screen.getByText(walletEn.entries.rowPrizeAmount)).toBeInTheDocument();
    expect(screen.getByText(walletEn.entries.rowRefundCredited)).toBeInTheDocument();
    expect(screen.getAllByRole("link", {name: walletEn.entries.rowGoToWallet})).toHaveLength(2);
    // Round 4 (not selected) and round 6 (void) credited nothing, so they offer no route to a balance.
    expect(screen.getByText(walletEn.entries.rowNotSelected)).toBeInTheDocument();
    expect(screen.getByText(walletEn.entries.rowVoid)).toBeInTheDocument();

    // A pending row never does either.
    fireEvent.click(tab("Active"));
    expect(screen.queryByRole("link", {name: walletEn.entries.rowGoToWallet})).toBeNull();
    expect(screen.queryByText(walletEn.entries.rowPrizeAmount)).toBeNull();
  });

  it("never reads the new account's positions against the previous account's round ids", async () => {
    const chain = scriptedChain();
    const wallet = await mount(chain);
    await waitFor(() => expect(tab("Active")).toHaveTextContent("Active (1)"));
    expect(screen.getByText("Round 1")).toBeInTheDocument();

    // Hold the new scan on its very first await, which is the window the previous account's completed scan
    // used to survive: its round ids were still in state, `partial` still said false, and the confirmation
    // read fired for the new account over the old account's rounds.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realGetBlockNumber = chain.node.getBlockNumber;
    chain.node.getBlockNumber = async () => {
      await held;
      return realGetBlockNumber();
    };
    const realCall = chain.node.call;
    const positionReads: bigint[] = [];
    chain.node.call = (tx: {to?: string | null; data?: string}) => {
      const parsed =
        (tx.to ?? "").toLowerCase() === chain.manifest.contracts.draw.address
          ? drawInterface.parseTransaction({data: tx.data ?? "0x"})
          : null;
      if (parsed?.name === "getPosition") positionReads.push(BigInt(String(parsed.args[0])));
      return realCall(tx);
    };

    await act(async () => {
      wallet.setAccounts([SECOND_ACCOUNT]);
    });

    expect(positionReads).toEqual([]);
    expect(screen.queryByText("Round 1")).toBeNull();
    expect(tab("Active")).toHaveTextContent("Active (0)");

    // Let the new scan run to the end so the test leaves nothing in flight.
    await act(async () => {
      release?.();
      await held;
    });
    await waitFor(() => expect(tab("Past")).toHaveTextContent("Past (0)"));
  });

  it("asks for a wallet before it reads anything", async () => {
    const chain = scriptedChain();
    renderSurface(<EntriesPage />, chain.base);
    await waitFor(() => expect(screen.getByText(walletEn.entries.connectPrompt)).toBeInTheDocument());
    expect(chain.logCalls).toHaveLength(0);
  });
});

// SPEC §9.7 keeps third-party text out of the app's own sentences. The live chain 97 build put ethers'
// "could not coalesce error (error={ "code": -32005, "message": "limit exceeded" } ...)" straight into the
// red panel, which is both the node's words as the app's and nothing a reader can act on.
describe("EntriesPage scan failures", () => {
  beforeEach(() => clearPositionScanCache());

  it("names the network, not the data, when the RPC throttles the read", () => {
    const wrapped = Object.assign(
      new Error(
        'could not coalesce error (error={ "code": -32005, "message": "limit exceeded" }, payload={ ' +
          '"method": "eth_getLogs" }, code=UNKNOWN_ERROR, version=6.17.0)',
      ),
      {error: {code: -32005, message: "limit exceeded"}},
    );
    const view = scanFailureView(new LogScanRateLimitError(10n, 74n, 7, wrapped));

    expect(view?.body).toBe(catalogEntryFor("RpcUnavailable").message);
    expect(view?.funds).toBe(catalogEntryFor("RpcUnavailable").funds);
    expect(view?.nextAction).toBe(catalogEntryFor("RpcUnavailable").nextAction);
    // The node's words survive exactly once, capped, and only on the labelled detail line.
    expect(view?.body).not.toContain("coalesce");
    expect(view?.detail).toContain("limit exceeded");
    expect((view?.detail ?? "").length).toBeLessThanOrEqual(WALLET_TEXT_MAX);
  });

  it("renders a catalog sentence rather than the provider's text, and keeps Scan again", async () => {
    const chain = fakeChain({
      blockNumber: 5_000,
      getLogs: () => {
        throw new Error('could not coalesce error (payload={ "method": "eth_getLogs" })');
      },
    });
    await mount(chain);

    const title = await screen.findByText(walletEn.entries.errorTitle);
    const panel = title.closest(".state-panel") as HTMLElement;
    expect(panel).toHaveAttribute("role", "alert");
    // Not the raw text: an unknown provider failure is still the app's own sentence (SPEC §9.7). The body is
    // the paragraph right under the title, and the node's words appear only on the labelled detail line.
    const body = panel.querySelectorAll("p")[1];
    expect(body?.textContent).toBe(en.error.body);
    expect(body?.textContent).not.toContain("coalesce");
    expect(screen.getByRole("button", {name: walletEn.entries.errorRetry})).toBeInTheDocument();
  });
});
