// The block-keyed read cache (SPEC §10.1, §9.3).
//
// "lists re-render only when the snapshot block hash changes" (§9.3) and "reuses the cached snapshot when the
// block hash is unchanged" (§10.1). That is the whole contract of this file: a read may run again, but if it
// comes back carrying the same `blockHash` the stored snapshot is left alone, so no consumer re-renders.
//
// The core is generic over the context type so it can be exercised with a plain fake in tests;
// `useSnapshot` is the one the app uses and supplies the verified `ReadContext`.

import {type ReadContext, resolveSnapshotBlock, type Snapshot, type SnapshotBlock} from "@luckydraw/client";
import {useCallback, useEffect, useRef, useState} from "react";
import {useDeployment} from "../deployment/DeploymentProvider.tsx";
import {useBlock} from "./BlockProvider.tsx";

export type SnapshotStatus = "idle" | "loading" | "ready" | "error";

export type SnapshotState<T> = {
  status: SnapshotStatus;
  /** The last successful snapshot, kept while a later read is in flight or failing. */
  snapshot: Snapshot<T> | null;
  value: T | null;
  error: Error | null;
  /** Re-runs the read now. A result carrying the same block hash still does not re-render. */
  refresh: () => void;
};

export type SnapshotOptions = {
  /** Extra values that change what the read asks for. A change discards the cached snapshot. */
  deps?: readonly unknown[];
  /** When false the read does not run and the state stays idle. */
  enabled?: boolean;
  /**
   * Whether this read shares the epoch's block with every other read on the page. Default true, which is
   * what §10.1 wants for anything displayed under one freshness label.
   *
   * Pass `false` for a read that must act on the latest on-chain state rather than on the displayed one —
   * an entry quote, a withdraw amount — so the client's own `actionBlockOf` picks the head (SPEC §9.6: buy,
   * withdraw and claim act on the latest state). On a chain whose `ReadContext` already pins `tag: "latest"`
   * the two are the same block.
   */
  pinBlock?: boolean;
};

// One resolved block per (read context, block epoch), so every adapter that runs in an epoch reads the same
// block and one page cannot mix two of them under one freshness label (SPEC §10.1: "Related direct reads use
// one blockTag"). The cache is keyed on the context object, which the deployment provider memoizes, and is
// weak so nothing is retained after a context is replaced.
const epochBlocks = new WeakMap<object, {epoch: number; block: Promise<SnapshotBlock>}>();

/** The block for this epoch, resolved once and shared. The context's own `tag`/`depth` policy is kept. */
export function blockForEpoch(ctx: ReadContext, epoch: number): Promise<SnapshotBlock> {
  const cached = epochBlocks.get(ctx);
  if (cached !== undefined && cached.epoch === epoch) return cached.block;
  const block = resolveSnapshotBlock(ctx.provider, {depth: ctx.depth, tag: ctx.tag});
  epochBlocks.set(ctx, {epoch, block});
  // A failed resolution must not be remembered, or every read in the epoch inherits one transport failure.
  block.catch(() => {
    const current = epochBlocks.get(ctx);
    if (current?.block === block) epochBlocks.delete(ctx);
  });
  return block;
}

/**
 * The block-keyed read, generic over its context.
 *
 * `epoch` is the value that makes the read run again (the app passes `blockEpoch`). `key` plus `deps`
 * identify what is being read: when either changes, the cached snapshot is dropped, because it describes a
 * different question.
 */
export function useKeyedSnapshot<Context, T>(
  ctx: Context | null,
  epoch: number,
  key: string,
  readFn: (ctx: Context) => Promise<Snapshot<T>>,
  options?: SnapshotOptions,
): SnapshotState<T> {
  const enabled = options?.enabled ?? true;
  const deps = options?.deps ?? [];
  const identity = `${key}|${deps.map((dep) => String(dep)).join("|")}`;

  const [state, setState] = useState<{
    status: SnapshotStatus;
    snapshot: Snapshot<T> | null;
    error: Error | null;
  }>({status: "idle", snapshot: null, error: null});

  const lastHash = useRef<string | null>(null);
  const lastIdentity = useRef<string | null>(null);
  const readRef = useRef(readFn);
  readRef.current = readFn;
  const [manual, setManual] = useState(0);

  // `epoch` (a new block) and `manual` (refresh) are the triggers that make the read run again; neither is
  // read inside the effect, which is why they look unnecessary to the rule.
  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch and manual are deliberate re-run triggers.
  useEffect(() => {
    if (ctx === null || !enabled) {
      // A read that becomes disabled — the account went away, the row is no longer asked for — must not keep
      // the previous answer on screen: that is how a disconnected account's balance survives a disconnect
      // (SPEC §9.2 "Disconnect clears account-sensitive caches and queries"). The functional update returns
      // the same object when there is nothing to clear, so a read that was never enabled does not re-render.
      lastHash.current = null;
      lastIdentity.current = null;
      setState((previous) =>
        previous.status === "idle" && previous.snapshot === null && previous.error === null
          ? previous
          : {status: "idle", snapshot: null, error: null},
      );
      return;
    }
    let live = true;
    if (lastIdentity.current !== identity) {
      lastIdentity.current = identity;
      lastHash.current = null;
      setState({status: "loading", snapshot: null, error: null});
    } else {
      setState((previous) => (previous.status === "idle" ? {...previous, status: "loading"} : previous));
    }

    void readRef
      .current(ctx)
      .then((snapshot) => {
        if (!live) return;
        // The identity of a snapshot is its block hash (SPEC §10.1). Same hash, same answer: do not touch
        // state, so nothing downstream re-renders.
        if (lastHash.current === snapshot.blockHash) {
          setState((previous) =>
            previous.status === "ready" && previous.error === null
              ? previous
              : {status: "ready", snapshot: previous.snapshot ?? snapshot, error: null},
          );
          return;
        }
        lastHash.current = snapshot.blockHash;
        setState({status: "ready", snapshot, error: null});
      })
      .catch((caught: unknown) => {
        if (!live) return;
        const error = caught instanceof Error ? caught : new Error(String(caught));
        setState((previous) => ({status: "error", snapshot: previous.snapshot, error}));
      });

    return () => {
      live = false;
    };
  }, [ctx, epoch, identity, enabled, manual]);

  const refresh = useCallback(() => setManual((value) => value + 1), []);

  return {
    status: state.status,
    snapshot: state.snapshot,
    value: state.snapshot === null ? null : state.snapshot.value,
    error: state.error,
    refresh,
  };
}

/**
 * The app's block-keyed read. Runs `readFn` once per new block against the verified `ReadContext`, and
 * re-renders only when the snapshot's block hash changes.
 *
 * Every read in one block epoch is handed the same already-resolved block on `ctx.block`, so two panels on
 * one page cannot be reading two different blocks under one freshness label (SPEC §10.1). Opt out with
 * `pinBlock: false` for a read whose value must come from the head.
 */
export function useSnapshot<T>(
  key: string,
  readFn: (ctx: ReadContext) => Promise<Snapshot<T>>,
  options?: SnapshotOptions,
): SnapshotState<T> {
  const {readCtx} = useDeployment();
  const {blockEpoch} = useBlock();
  const pinBlock = options?.pinBlock ?? true;
  // Deliberately not memoized: `useKeyedSnapshot` keeps the read function in a ref and never depends on its
  // identity, so this closes over the current `readFn` on every render without re-running anything.
  const pinned = async (ctx: ReadContext): Promise<Snapshot<T>> => {
    if (!pinBlock) return await readFn(ctx);
    return await readFn({...ctx, block: await blockForEpoch(ctx, blockEpoch)});
  };
  return useKeyedSnapshot(readCtx, blockEpoch, key, pinned, options);
}
