// The refund claim: `claimRefund(roundId, account)` for the connected account and for nobody else
// (SPEC §6.2 Refunding, §8.1, §9.5).

import {type Address, luckyDrawAbi, State} from "@luckydraw/client";
import {act, fireEvent, screen, waitFor} from "@testing-library/react";
import {Interface} from "ethers";
import {describe, expect, it} from "vitest";
import {rowOf} from "../../lib/positions/classify.ts";
import {useTransaction} from "../../lib/tx/useTransaction.tsx";
import {useWallet} from "../../lib/wallet/WalletProvider.tsx";
import {walletEn} from "../../strings/wallet.ts";
import {RefundCard} from "./RefundCard.tsx";
import {
  ACCOUNT,
  ConnectButton,
  connectTestWallet,
  fakeChain,
  fakeTxRuntime,
  NATIVE,
  positionFixture,
  renderSurface,
  roundFixture,
} from "./testKit.tsx";

const SOMEONE_ELSE = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address;
const drawInterface = new Interface(luckyDrawAbi);

function Harness({refunded, runtime}: {refunded: boolean; runtime: ReturnType<typeof fakeTxRuntime>}) {
  const wallet = useWallet();
  const tx = useTransaction({runtime: runtime.runtime, resume: false});
  if (wallet.account === null) return <p>not connected</p>;
  const round = roundFixture(5n, {state: State.Refunding});
  const row = rowOf(round, positionFixture({gross: 1_000n, refunded}), wallet.account);
  const chain = fakeChain({});
  const asset = chain.manifest.assets.find((entry) => entry.asset === NATIVE) ?? null;
  return (
    <RefundCard
      row={row}
      asset={asset}
      chainId={31_337n}
      account={wallet.account}
      tx={tx}
      onClaimed={() => undefined}
    />
  );
}

async function mount(refunded = false) {
  const chain = fakeChain({});
  const runtime = fakeTxRuntime();
  renderSurface(
    <>
      <ConnectButton />
      <Harness refunded={refunded} runtime={runtime} />
    </>,
    chain.base,
  );
  await connectTestWallet();
  return {chain, runtime};
}

describe("RefundCard", () => {
  it("shows the decoded summary first and sends nothing until the second control", async () => {
    const {runtime} = await mount(false);
    const review = await screen.findByRole("button", {name: /Claim the refund for round 5/});
    expect(screen.queryByText("claimRefund")).toBeNull();

    await act(async () => {
      fireEvent.click(review);
    });

    // SPEC §9.6: the decoded function, the round, the account credited and what the balance gains are all on
    // screen before the wallet can open, and the first click opened nothing.
    expect(runtime.sent).toHaveLength(0);
    expect(screen.getByText("claimRefund")).toBeInTheDocument();
    expect(screen.getByText(ACCOUNT)).toBeInTheDocument();
    expect(screen.getByText(/credits .* to your LuckyDraw balance/)).toBeInTheDocument();
    expect(screen.getByRole("button", {name: walletEn.entries.refundCancel})).toBeInTheDocument();
  });

  it("builds claimRefund(roundId, account) for the connected account only", async () => {
    const {runtime} = await mount(false);
    const button = await screen.findByRole("button", {name: /Claim the refund for round 5/});

    await act(async () => {
      fireEvent.click(button);
    });
    expect(runtime.sent).toHaveLength(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", {name: /Claim the refund for round 5/}));
    });
    await waitFor(() => expect(runtime.sent).toHaveLength(1));

    const parsed = drawInterface.parseTransaction({data: runtime.sent[0]?.data ?? "0x"});
    expect(parsed?.name).toBe("claimRefund");
    expect(parsed?.args[0]).toBe(5n);
    expect(String(parsed?.args[1]).toLowerCase()).toBe(ACCOUNT);
    expect(String(parsed?.args[1]).toLowerCase()).not.toBe(SOMEONE_ELSE);
    expect(runtime.sent[0]?.from).toBe(ACCOUNT);
    expect(runtime.sent[0]?.value).toBe(0n);
  });

  it("replaces the claim with the credited line once the contract says it is refunded", async () => {
    const {runtime} = await mount(true);
    await waitFor(() => expect(screen.getByText(walletEn.entries.rowClaimed)).toBeInTheDocument());

    // Nothing to claim twice: a second call would revert AlreadyClaimed (SPEC §6.2).
    expect(screen.queryByRole("button", {name: /Claim the refund/})).toBeNull();
    expect(screen.getByRole("link", {name: walletEn.entries.rowGoToWallet})).toBeInTheDocument();
    expect(runtime.sent).toHaveLength(0);
  });
});
