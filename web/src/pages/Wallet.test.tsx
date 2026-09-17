// `/wallet`: the two columns, the committed line, and the top-up entry point of SPEC §9.5.

import {act, fireEvent, screen, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it} from "vitest";
import {
  ConnectButton,
  connectTestWallet,
  fakeChain,
  fakeTxRuntime,
  NATIVE,
  renderSurface,
  TOKEN,
} from "../components/wallet/testKit.tsx";
import {clearPositionScanCache} from "../lib/positions/usePositions.ts";
import {walletEn} from "../strings/wallet.ts";
import {WalletPage} from "./Wallet.tsx";

const ONE_BNB = 1_000_000_000_000_000_000n;

async function mount(search: string) {
  const chain = fakeChain({
    vaultBalances: {[NATIVE]: 2n * ONE_BNB, [TOKEN]: 12_345n},
    tokenBalances: {[TOKEN]: 50_000n},
    nativeBalance: 3n * ONE_BNB,
  });
  const runtime = fakeTxRuntime();
  renderSurface(
    <>
      <ConnectButton />
      <WalletPage txRuntime={runtime.runtime} />
    </>,
    chain.base,
    {initialEntries: [`/wallet${search}`]},
  );
  await connectTestWallet();
  await waitFor(() => expect(screen.getAllByLabelText(walletEn.deposit.amountLabel)).toHaveLength(2));
  return {chain, runtime};
}

describe("WalletPage", () => {
  beforeEach(() => clearPositionScanCache());

  it("shows the wallet column, the LuckyDraw column and committed separately for every asset", async () => {
    await mount("");

    await waitFor(() => expect(screen.getByText("3 BNB")).toBeInTheDocument());
    // Available in LuckyDraw, and the two-decimal token formatted in its own decimals.
    expect(screen.getByText("2 BNB")).toBeInTheDocument();
    expect(screen.getByText("500 TEST2")).toBeInTheDocument();
    expect(screen.getByText("123.45 TEST2")).toBeInTheDocument();
    // Committed is its own line on every card, never folded into available.
    expect(screen.getAllByText(walletEn.wallet.committed)).toHaveLength(2);
  });

  it("prefills the amount and preselects the asset a top-up link names", async () => {
    await mount(`?asset=${TOKEN}&amount=12.34&intent=9`);

    expect(screen.getByText(walletEn.wallet.topUpHeading)).toBeInTheDocument();
    const fields = screen.getAllByLabelText(walletEn.deposit.amountLabel);
    // The named asset's card is first, and only its deposit field carries the prefill.
    expect((fields[0] as HTMLInputElement).value).toBe("12.34");
    expect((fields[1] as HTMLInputElement).value).toBe("");
    // Nothing was bought and nothing was signed: the round action appears only after a receipt.
    expect(screen.queryByText(walletEn.wallet.topUpBack)).toBeNull();
  });

  it("offers one way back to the round once the top-up deposit is included", async () => {
    const {runtime} = await mount(`?asset=${NATIVE}&amount=1&intent=9`);

    const field = screen.getAllByLabelText(walletEn.deposit.amountLabel)[0] as HTMLInputElement;
    expect(field.value).toBe("1");
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", {name: walletEn.deposit.review})[0] as HTMLElement);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", {name: walletEn.deposit.confirm}));
    });

    await waitFor(() => expect(runtime.sent).toHaveLength(1));
    const back = await screen.findByRole("link", {name: walletEn.wallet.topUpBack});
    expect(back).toHaveAttribute("href", "/round/31337/9");
    expect(screen.getAllByRole("link", {name: walletEn.wallet.topUpBack})).toHaveLength(1);
  });

  it("says so when a top-up link names an asset this deployment does not have", async () => {
    await mount("?asset=0x00000000000000000000000000000000deadbeef&amount=1&intent=9");
    expect(screen.getByText(walletEn.wallet.topUpUnknownAsset)).toBeInTheDocument();
  });

  it("asks for a wallet before it reads any balance", async () => {
    const chain = fakeChain({});
    renderSurface(<WalletPage />, chain.base, {initialEntries: ["/wallet"]});
    await waitFor(() => expect(screen.getByText(walletEn.wallet.connectPrompt)).toBeInTheDocument());
    expect(screen.queryByLabelText(walletEn.deposit.amountLabel)).toBeNull();
  });
});
