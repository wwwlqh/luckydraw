// `useSigner` refuses a signer for anything but the quoted account on the deployment's chain (SPEC §9.5,
// §9.2). The chain half is the interesting one: the write gate reads React state, which only moves when the
// wallet emits `chainChanged`, so the hook asks the provider itself immediately before it builds a signer.

import type {Address} from "@luckydraw/client";
import {act, fireEvent, screen, waitFor} from "@testing-library/react";
import {useState} from "react";
import {describe, expect, it} from "vitest";
import {announce, FakeWallet, renderWithProviders, testDeploymentBase} from "../../test/harness.tsx";
import {WalletError} from "./errors.ts";
import {useSigner} from "./useSigner.ts";
import {useWallet} from "./WalletProvider.tsx";

// Correctly checksummed on purpose: ethers reads `eth_accounts` straight from the provider and rejects a
// mixed-case address whose checksum does not hold, which is a fixture problem, not a wallet condition.
const ACCOUNT_A = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function Probe({account}: {account: string}) {
  const wallet = useWallet();
  const {requestSigner} = useSigner();
  const [result, setResult] = useState("-");
  return (
    <div>
      <span data-testid="status">{wallet.status}</span>
      <span data-testid="result">{result}</span>
      <button type="button" onClick={() => void wallet.connect("io.metamask")}>
        connect
      </button>
      <button
        type="button"
        onClick={() => {
          setResult("-");
          void requestSigner(account.toLowerCase() as Address)
            .then(() => setResult("signer"))
            .catch((error: unknown) =>
              setResult(error instanceof WalletError ? error.code : `other:${String(error)}`),
            );
        }}
      >
        request
      </button>
    </div>
  );
}

async function connected(wallet: FakeWallet) {
  renderWithProviders(<Probe account={ACCOUNT_A} />, {base: testDeploymentBase()});
  await act(async () => {
    announce("MetaMask", "io.metamask", wallet);
  });
  fireEvent.click(screen.getByText("connect"));
  await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("connected"));
}

describe("useSigner", () => {
  it("hands out a signer for the quoted account on the deployment's chain", async () => {
    const wallet = new FakeWallet([ACCOUNT_A]);
    await connected(wallet);

    fireEvent.click(screen.getByText("request"));

    await waitFor(() => expect(screen.getByTestId("result").textContent).toBe("signer"));
  });

  it("refuses when the wallet changed network without announcing it", async () => {
    const wallet = new FakeWallet([ACCOUNT_A]);
    await connected(wallet);
    // A chain change the page never heard about: no `chainChanged`, so React state — and the write gate with
    // it — still says 31337 while the wallet would sign on chain 1.
    wallet.chainId = 1n;

    fireEvent.click(screen.getByText("request"));

    await waitFor(() => expect(screen.getByTestId("result").textContent).toBe("WrongChain"));
  });
});
