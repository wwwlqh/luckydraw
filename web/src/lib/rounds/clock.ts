// The one clock every countdown on these pages reads (SPEC §9.6, §10.1).
//
// "Countdown uses a recent chain timestamp plus monotonic elapsed time; the client clock never authorizes an
// entry." So: anchor on the snapshot's block timestamp, advance it with the app's single monotonic 1 Hz
// ticker (`useSecondsTick`, which reports `performance.now()` deltas), and re-anchor whenever a new block
// arrives. `Date.now()` appears nowhere on this path, so a device whose clock is wrong sees the same
// countdown as everyone else.

import type {Snapshot} from "@luckydraw/client";
import {useEffect, useRef, useState} from "react";
import {useSecondsTick} from "../data/BlockProvider.tsx";

/**
 * Chain seconds now: the snapshot's timestamp plus whole seconds elapsed on the monotonic ticker since that
 * snapshot arrived. Returns 0 before the first snapshot, which every caller renders as "loading" anyway.
 */
export function useChainNow(snapshot: Snapshot<unknown> | null): bigint {
  const tickMs = useSecondsTick();
  const tickRef = useRef(tickMs);
  tickRef.current = tickMs;

  const [anchor, setAnchor] = useState<{tick: number; timestamp: bigint} | null>(null);
  const timestamp = snapshot?.timestamp ?? null;

  // The timestamp, not the block hash, is the anchor: two blocks can carry the same second, and re-anchoring
  // on the hash alone would reset the elapsed count and make the countdown stand still for a second.
  useEffect(() => {
    if (timestamp === null) return;
    setAnchor({tick: tickRef.current, timestamp});
  }, [timestamp]);

  if (anchor === null) return timestamp ?? 0n;
  const elapsedMs = tickMs - anchor.tick;
  const elapsed = elapsedMs > 0 ? BigInt(Math.floor(elapsedMs / 1000)) : 0n;
  return anchor.timestamp + elapsed;
}
