// The block-keyed read cache (SPEC §9.3 "lists re-render only when the snapshot block hash changes").

import {readSeedAccount, type Snapshot} from "@luckydraw/client";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it} from "vitest";
import type {fakeNode} from "../../test/harness.tsx";
import {renderWithProviders, testDeploymentBase} from "../../test/harness.tsx";
import {useKeyedSnapshot, useSnapshot} from "./useSnapshot.ts";

type Ctx = {label: string};

// Hoisted on purpose: `useKeyedSnapshot` keys its effect on the context identity, so an inline object
// literal would re-run the read on every render. The app passes the memoized `ReadContext`.
const CTX: Ctx = {label: "ctx"};

function snapshotOf(value: number, blockHash: string): Snapshot<number> {
  return {
    chainId: 31_337n,
    blockNumber: 100n,
    blockHash: blockHash as `0x${string}`,
    timestamp: 1_760_000_000n,
    confidence: {tag: "latest", depth: 0n},
    value,
  };
}

describe("useKeyedSnapshot", () => {
  it("hands out a new snapshot only when the block hash changes", async () => {
    let hash = `0x${"11".repeat(32)}`;
    let value = 1;
    let reads = 0;
    // The identities a consumer would memoize on. A re-read at the same block must not add one.
    const seen: Snapshot<number>[] = [];

    function Probe() {
      const state = useKeyedSnapshot<Ctx, number>(CTX, 0, "probe", () => {
        reads += 1;
        return Promise.resolve(snapshotOf(value, hash));
      });
      if (state.snapshot !== null && seen[seen.length - 1] !== state.snapshot) seen.push(state.snapshot);
      return (
        <div>
          <span data-testid="value">{state.value ?? "-"}</span>
          <button type="button" onClick={state.refresh}>
            refresh
          </button>
        </div>
      );
    }

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("1"));
    expect(seen).toHaveLength(1);

    // Same block: the read runs again, the value it carries is ignored, and the snapshot is not replaced.
    value = 2;
    fireEvent.click(screen.getByText("refresh"));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.getByTestId("value").textContent).toBe("1");
    expect(seen).toHaveLength(1);

    // New block: the snapshot is replaced and the consumer sees the new value.
    hash = `0x${"22".repeat(32)}`;
    fireEvent.click(screen.getByText("refresh"));
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("2"));
    expect(seen).toHaveLength(2);
  });

  it("keeps the last good snapshot when a later read fails", async () => {
    let fail = false;
    function Probe() {
      const state = useKeyedSnapshot<Ctx, number>(CTX, 0, "probe", () => {
        if (fail) return Promise.reject(new Error("node unreachable"));
        return Promise.resolve(snapshotOf(7, `0x${"33".repeat(32)}`));
      });
      return (
        <div>
          <span data-testid="value">{state.value ?? "-"}</span>
          <span data-testid="status">{state.status}</span>
          <span data-testid="error">{state.error?.message ?? "-"}</span>
          <button type="button" onClick={state.refresh}>
            refresh
          </button>
        </div>
      );
    }

    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("7"));

    fail = true;
    fireEvent.click(screen.getByText("refresh"));
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("error"));
    expect(screen.getByTestId("value").textContent).toBe("7");
    expect(screen.getByTestId("error").textContent).toBe("node unreachable");
  });

  it("clears the last answer when the read stops being enabled", async () => {
    // An account-scoped read whose account goes away must not keep the previous account's number on screen
    // (SPEC §9.2 "Disconnect clears account-sensitive caches and queries").
    function Probe({account}: {account: string | null}) {
      const state = useKeyedSnapshot<Ctx, number>(
        CTX,
        0,
        "balance",
        () => Promise.resolve(snapshotOf(42, `0x${"55".repeat(32)}`)),
        {deps: [account], enabled: account !== null},
      );
      return (
        <div>
          <span data-testid="value">{state.value ?? "-"}</span>
          <span data-testid="status">{state.status}</span>
        </div>
      );
    }

    const {rerender} = render(<Probe account="0xaaaa" />);
    await waitFor(() => expect(screen.getByTestId("value").textContent).toBe("42"));

    rerender(<Probe account={null} />);

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("idle"));
    expect(screen.getByTestId("value").textContent).toBe("-");
  });

  it("does not read at all while the context is null", async () => {
    let reads = 0;
    function Probe() {
      const state = useKeyedSnapshot<Ctx, number>(null, 0, "probe", () => {
        reads += 1;
        return Promise.resolve(snapshotOf(1, `0x${"44".repeat(32)}`));
      });
      return <span data-testid="status">{state.status}</span>;
    }
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("idle"));
    expect(reads).toBe(0);
  });
});

describe("useSnapshot", () => {
  it("gives every read in one block epoch the same block", async () => {
    // SPEC §10.1: "Related direct reads use one blockTag". Two panels on one page under one freshness label
    // must not be two different blocks, so the block is resolved once per epoch and shared.
    const base = testDeploymentBase();
    const node = base.provider as unknown as ReturnType<typeof fakeNode>;
    const seen: Snapshot<string>[] = [];

    function Two() {
      const first = useSnapshot("seed:first", readSeedAccount);
      const second = useSnapshot("seed:second", readSeedAccount);
      if (first.snapshot !== null && second.snapshot !== null) {
        seen[0] = first.snapshot;
        seen[1] = second.snapshot;
      }
      return (
        <div>
          <span data-testid="first">{first.snapshot?.blockHash ?? "-"}</span>
          <span data-testid="second">{second.snapshot?.blockHash ?? "-"}</span>
        </div>
      );
    }

    renderWithProviders(<Two />, {base});

    await waitFor(() => expect(screen.getByTestId("second").textContent).not.toBe("-"));
    expect(seen).toHaveLength(2);
    expect(seen[0]?.blockHash).toBe(seen[1]?.blockHash);
    expect(seen[0]?.blockNumber).toBe(seen[1]?.blockNumber);
    // One resolution for the epoch, not one per adapter. (The other `getBlock` calls are the client's own
    // post-batch head re-check, which is per read by design.)
    expect(node.blockTags.filter((tag) => tag === "latest")).toHaveLength(1);
  });
});
