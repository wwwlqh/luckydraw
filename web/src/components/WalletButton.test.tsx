// The Connect control and the dialog's focus return (SPEC §9.2, §9.7 "dialogs with focus trap and focus
// return").
//
// The case that matters is a connection that succeeds: the button the dialog returns focus to is the very
// control the account chip replaced, so restoring focus to it drops the caret on <body> and a keyboard user
// is silently sent back to the top of the page.

import {act, fireEvent, screen, waitFor} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import {en, fill} from "../strings/en.ts";
import {announce, FakeWallet, renderWithProviders, testDeploymentBase} from "../test/harness.tsx";
import {ACCOUNT_CHIP_ATTRIBUTE, truncateAddress} from "./AccountChip.tsx";
import {WalletButton} from "./WalletButton.tsx";

const ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("WalletButton", () => {
  it("leaves focus inside the account chip after a keyboard connect", async () => {
    const wallet = new FakeWallet([ACCOUNT]);
    renderWithProviders(<WalletButton />, {base: testDeploymentBase()});
    await act(async () => {
      announce("MetaMask", "io.metamask", wallet);
    });

    const connect = screen.getByRole("button", {name: en.wallet.connect});
    connect.focus();
    fireEvent.click(connect);
    const entry = await screen.findByRole("button", {name: /MetaMask/});
    fireEvent.click(entry);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const chip = document.querySelector(`[${ACCOUNT_CHIP_ATTRIBUTE}]`);
    expect(chip).not.toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(chip?.contains(document.activeElement)).toBe(true);
  });

  it("announces the connected account politely", async () => {
    const wallet = new FakeWallet([ACCOUNT]);
    renderWithProviders(<WalletButton />, {base: testDeploymentBase()});
    await act(async () => {
      announce("MetaMask", "io.metamask", wallet);
    });
    fireEvent.click(screen.getByRole("button", {name: en.wallet.connect}));
    fireEvent.click(await screen.findByRole("button", {name: /MetaMask/}));

    const region = await screen.findByRole("status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region.textContent).toBe(
      fill(en.wallet.connected, {address: truncateAddress(ACCOUNT.toLowerCase())}),
    );
  });
});
