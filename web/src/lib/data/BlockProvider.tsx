// One block poller for the whole app, and one 1 Hz ticker (SPEC §10.1, §9.6).
//
// SPEC §10.1: "the client refreshes snapshots at most every 4 seconds [...] reuses the cached snapshot when
// the block hash is unchanged, and stays under 30 RPC requests per minute per idle tab". So there is exactly
// one `eth_blockNumber` poll in the page, and `blockEpoch` advances only when the head actually moved: a tab
// sitting on an idle chain makes one request per interval and re-renders nothing.
//
// SPEC §9.6: "Countdown uses a recent chain timestamp plus monotonic elapsed time; the client clock never
// authorizes an entry" and "drives all countdowns from one 1 Hz ticker". `useSecondsTick` is that ticker; it
// reports elapsed milliseconds from `performance.now()`, which is monotonic, not a wall clock.

import type {JsonRpcProvider} from "ethers";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type BlockContextValue = {
  /** Head block number, or null before the first successful poll. */
  blockNumber: bigint | null;
  /** Increases whenever the head moves or `refresh()` is called. Snapshot reads key on it. */
  blockEpoch: number;
  /** The last poll failure, or null. Reads keep showing their previous snapshot while this is set. */
  error: Error | null;
  /** Forces an immediate poll and advances `blockEpoch`. */
  refresh: () => void;
  /** Milliseconds since the provider mounted, updated once a second. Ages and countdowns read it. */
  tickMs: number;
};

const BlockContext = createContext<BlockContextValue | null>(null);

export type BlockProviderProps = {
  children: ReactNode;
  /** Null while the deployment has not verified: nothing is polled until reads are allowed. */
  provider: Pick<JsonRpcProvider, "getBlockNumber"> | null;
  pollMs: number;
};

export function BlockProvider({children, provider, pollMs}: BlockProviderProps) {
  const [blockNumber, setBlockNumber] = useState<bigint | null>(null);
  const [blockEpoch, setBlockEpoch] = useState(0);
  const [error, setError] = useState<Error | null>(null);
  const [tickMs, setTickMs] = useState(0);
  const [manual, setManual] = useState(0);
  const lastSeen = useRef<bigint | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `manual` is the refresh trigger, not a value the effect reads.
  useEffect(() => {
    if (provider === null) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      try {
        const head = BigInt(await provider.getBlockNumber());
        if (!live) return;
        setError(null);
        if (lastSeen.current === null || head !== lastSeen.current) {
          lastSeen.current = head;
          setBlockNumber(head);
          setBlockEpoch((epoch) => epoch + 1);
        }
      } catch (caught) {
        if (!live) return;
        setError(caught instanceof Error ? caught : new Error(String(caught)));
      } finally {
        if (live) timer = setTimeout(() => void poll(), pollMs);
      }
    };

    void poll();
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [provider, pollMs, manual]);

  useEffect(() => {
    const started = performance.now();
    const timer = setInterval(() => setTickMs(performance.now() - started), 1_000);
    return () => clearInterval(timer);
  }, []);

  const refresh = useCallback(() => {
    lastSeen.current = null;
    setManual((value) => value + 1);
  }, []);

  const value = useMemo<BlockContextValue>(
    () => ({blockNumber, blockEpoch, error, refresh, tickMs}),
    [blockNumber, blockEpoch, error, refresh, tickMs],
  );

  return <BlockContext.Provider value={value}>{children}</BlockContext.Provider>;
}

/** The shared block poller. Throws outside the provider. */
export function useBlock(): BlockContextValue {
  const value = useContext(BlockContext);
  if (value === null) throw new Error("useBlock must be used inside <BlockProvider>.");
  return value;
}

/** The shared block poller, or null outside the provider. Leaf components that only want the tick use this. */
export function useBlockOptional(): BlockContextValue | null {
  return useContext(BlockContext);
}

/**
 * Monotonic milliseconds since the app mounted, updated once a second by the single app ticker.
 * Returns 0 outside the provider, so a leaf component that only re-renders on the tick stays mountable on
 * its own (a component catalog fixture, a test).
 */
export function useSecondsTick(): number {
  return useBlockOptional()?.tickMs ?? 0;
}
