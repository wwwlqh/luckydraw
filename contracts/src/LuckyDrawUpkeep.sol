// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    AutomationCompatibleInterface
} from "@chainlink/contracts/src/v0.8/automation/interfaces/AutomationCompatibleInterface.sol";

import {LuckyDraw} from "./LuckyDraw.sol";
import {ILuckyDraw} from "./interfaces/ILuckyDraw.sol";
import {InvalidAmount, InvalidConfig, WrongState} from "./Errors.sol";
import {KIND_COUNT, Kind, State} from "./Types.sol";

/// @title LuckyDrawUpkeep
/// @notice Chainlink Automation custom-logic executor for the SPEC §6.2 lifecycle (SPEC §10.3, ADR 039).
/// @dev The third executor beside the operator keeper and the manual path. It holds no funds, has no owner, no
///      privileged role and no storage at all: everything it can do, any address could already do by calling the
///      same four public Draw functions. Losing this contract loses nothing but redundancy; a compromised
///      Automation registry gains nothing it did not already have as an anonymous caller.
///
///      Deliberate non-features, each one a way this contract could have become a privilege:
///      - no `receive`/`fallback` and no payable function, so it can never hold value;
///      - no owner, no pause, no setter, no upgrade path and no `DRAW` migration: `DRAW` is immutable;
///      - no arbitrary-call entry point: `performUpkeep` dispatches over a four-member enum onto four named
///        selectors and nothing else, so `performData` can never be turned into calldata of the caller's choosing;
///      - no `seedRound`, no `claimRefund` and no owner method. The seed spends the seed account's balance
///        (SPEC §5.4) and the refund credits a named buyer (D9); both are the keeper's and the player's business,
///        not an unattended executor's. The four actions here move a round along the §6.2 table and move no money
///        that the round's own terms do not already fix.
///
///      Relationship to `keeper/src/decide.ts`: the eligibility table below is the same §6.2 table, minus the two
///      rows just named, and read from chain time rather than a snapshot block. The keeper and this contract
///      racing each other is harmless: every Draw method is idempotent by state, so the loser reverts with a named
///      error and wastes only gas (SPEC §10.2 "on-chain idempotency makes any overlap harmless").
contract LuckyDrawUpkeep is AutomationCompatibleInterface {
    /// @notice The one action `performUpkeep` will take, or `None`.
    /// @dev ABI order is fixed. `abi.decode` rejects a value outside the enum, so an out-of-range action from a
    ///      malicious registry reverts before any dispatch.
    enum Action {
        None,
        CloseRound,
        RequestDraw,
        ExpireUnrequested,
        Settle
    }

    /// @notice The Draw this executor drives, fixed at construction. There is no setter.
    LuckyDraw public immutable DRAW;

    /// @notice Largest number of pools one `checkUpkeep` scans (`MAX_POOL_PAGE * KIND_COUNT` `getRound` calls).
    /// @dev Sixteen pools is 112 current rounds per call. Each `getRound` copies a fixed-size struct, so the page
    ///      is tens of millions of gas at worst -- irrelevant to an `eth_call` simulation and bounded by a
    ///      constant rather than by `poolCount`, which the owner can grow. Sixteen is also inside the Draw's own
    ///      1..100 page limit (`LuckyDraw.MAX_PAGE`), so `getPools` can never revert `InvalidAmount` here. A
    ///      deployment with more pools registers a second upkeep with `checkData` pointing at the next page.
    uint256 public constant MAX_POOL_PAGE = 16;

    /// @notice Largest number of historical round identifiers one `checkUpkeep` scans.
    /// @dev The historical sweep exists because `closeRound` advances `current` in the same transaction, so a
    ///      round that still needs a request, an expiry or a settlement stops being any pool's current round the
    ///      moment it closes (the same gap `keeper/src/keeper.ts` covers with its in-memory `tracked` set). Round
    ///      identifiers are a dense global sequence 1..`roundCount`, so the sweep is a window over that range and
    ///      needs no log scan. 256 is about 36 periods of a 7-sequence pool and comfortably past the 24-hour
    ///      request window that bounds how long an unresolved round can matter.
    uint256 public constant MAX_ROUND_PAGE = 256;

    /// @notice Emitted once per action actually executed.
    /// @param action The action taken.
    /// @param roundId The round it was taken on.
    /// @param caller The registry (or anyone else) that called `performUpkeep`.
    event UpkeepPerformed(Action indexed action, uint256 indexed roundId, address indexed caller);

    /// @notice Binds the executor to one Draw for the life of the deployment.
    /// @dev Reverts `InvalidConfig` for address(0) or an address with no code, exactly as the Draw's own
    ///      constructor does for its Vault and coordinator.
    /// @param draw The deployed `LuckyDraw`.
    constructor(address draw) {
        if (draw == address(0) || draw.code.length == 0) revert InvalidConfig();
        DRAW = LuckyDraw(draw);
    }

    // ---------------------------------------------------------------------
    // AutomationCompatibleInterface
    // ---------------------------------------------------------------------

    /// @notice Finds at most one due lifecycle action over a bounded slice of the Draw's rounds.
    /// @dev `view`, although the interface declares it mutable: the registry only ever simulates it, and a view
    ///      function cannot be tricked into changing state if somebody calls it for real.
    ///
    ///      Two phases, in this order:
    ///        1. the current round of every `Kind` of every pool in the `checkData` page, which is where a due
    ///           `closeRound` almost always is;
    ///        2. a window of historical round identifiers, which is where a round that closed but was never
    ///           requested, expired or settled ends up.
    ///      Both phases are bounded by the constants above and by nothing else, so a growing `poolCount` or
    ///      `roundCount` cannot turn this into an unbounded scan.
    ///
    ///      `requestDraw` additionally reproduces the two SPEC §6.2 pre-checks the Draw itself performs -- the
    ///      gas lane is still registered and the subscription's native balance covers `(pendingRequests + 1)`
    ///      requests -- and reports no action for that round when either fails, so an upkeep is not spent on a
    ///      transaction that would certainly revert. The round is not lost: it stays `AwaitingRequest` and this
    ///      contract offers `expireUnrequested` on it once its deadline passes.
    /// @param checkData Empty, or `abi.encode(poolCursor, poolLimit, roundCursor, roundLimit)`. Empty means the
    ///        first `MAX_POOL_PAGE` pools and the newest `MAX_ROUND_PAGE` round identifiers. `poolCursor` and
    ///        `roundCursor` are zero-based offsets; the limits are clamped to the constants above, and a zero
    ///        limit means the constant. The historical window is round ids `roundCursor+1 .. roundCursor+limit`.
    /// @return upkeepNeeded True when `performData` names an action.
    /// @return performData `abi.encode(Action, roundId)`; `(Action.None, 0)` when nothing is due.
    function checkUpkeep(bytes calldata checkData)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        (uint256 poolCursor, uint256 poolLimit, uint256 roundCursor, uint256 roundLimit) = _page(checkData);

        (Action action, uint256 roundId) = _scanCurrent(poolCursor, poolLimit);
        if (action == Action.None) (action, roundId) = _scanHistory(checkData.length == 0, roundCursor, roundLimit);

        return (action != Action.None, abi.encode(action, roundId));
    }

    /// @notice Executes exactly one revalidated lifecycle action.
    /// @dev The registry's `performData` is untrusted input, as Chainlink's own interface documentation insists:
    ///      the state it was derived from may have moved, or it may never have come from `checkUpkeep` at all.
    ///      So the round is re-read here and the action is recomputed from that fresh read; a mismatch reverts
    ///      `WrongState` and nothing is called. An unknown `roundId` reverts inside `getRound` (`InvalidId`).
    ///
    ///      Revalidation is state-only: it deliberately does *not* repeat `checkUpkeep`'s VRF pre-checks. A
    ///      subscription that fell below the threshold between the simulation and the transaction surfaces as the
    ///      Draw's own `SubscriptionUnderfunded`, which is the error the operator's alerting is built around
    ///      (SPEC §10.3 "Subscription balance"), rather than as this contract's generic `WrongState`.
    ///
    ///      Anyone may call this. There is nothing to protect: each branch calls a Draw method that is already
    ///      public to every address (SPEC §8.1), and the Draw re-validates state, time and reentrancy itself.
    /// @param performData `abi.encode(Action, roundId)`.
    function performUpkeep(bytes calldata performData) external override {
        (Action action, uint256 roundId) = abi.decode(performData, (Action, uint256));
        if (action == Action.None || roundId == 0) revert InvalidAmount();

        ILuckyDraw.RoundView memory round = DRAW.getRound(roundId);
        if (_stateAction(round) != action) revert WrongState();

        if (action == Action.CloseRound) {
            DRAW.closeRound(roundId);
        } else if (action == Action.RequestDraw) {
            DRAW.requestDraw(roundId);
        } else if (action == Action.ExpireUnrequested) {
            DRAW.expireUnrequested(roundId);
        } else {
            DRAW.settle(roundId);
        }

        emit UpkeepPerformed(action, roundId, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Eligibility (the SPEC §6.2 table, minus seed and refund)
    // ---------------------------------------------------------------------

    /// @notice The action this round's own state and the chain clock make due, ignoring VRF readiness.
    /// @dev The only branch that needs a comment is `Open`: `LuckyDraw.closeRound` reverts `RoundNotClosed`
    ///      before `closesAt`, and a target close is not a close *call* at all -- it happens inside the
    ///      purchase that reaches the target (SPEC §6.2, ADR 031), so it is never an executor action. "Open past
    ///      cutoff" is therefore the Draw's whole view of close eligibility.
    /// @param round The round as `getRound` returned it.
    /// @return The due action, or `Action.None`.
    function stateAction(ILuckyDraw.RoundView memory round) external view returns (Action) {
        return _stateAction(round);
    }

    /// @notice Whether the Draw's own §6.2 request pre-checks would pass right now.
    /// @dev Reads the coordinator the Draw is immutably bound to, with the Draw's own immutable subscription id,
    ///      key hash and per-request cost, so this can never diverge from what `requestDraw` will check.
    /// @return ready True when the gas lane is registered and the subscription covers one more request.
    function requestReady() public view returns (bool ready) {
        (bool exists,) = DRAW.VRF_COORDINATOR().s_provingKeys(DRAW.KEY_HASH());
        if (!exists) return false;
        (, uint96 nativeBalance,,,) = DRAW.VRF_COORDINATOR().getSubscription(DRAW.SUBSCRIPTION_ID());
        return uint256(nativeBalance) >= (DRAW.pendingRequests() + 1) * DRAW.MAX_REQUEST_COST_NATIVE();
    }

    function _stateAction(ILuckyDraw.RoundView memory round) private view returns (Action) {
        State state = round.state;
        if (state == State.Open) {
            return block.timestamp >= round.closesAt ? Action.CloseRound : Action.None;
        }
        if (state == State.AwaitingRequest) {
            return block.timestamp < round.requestDeadline ? Action.RequestDraw : Action.ExpireUnrequested;
        }
        if (state == State.Ready) return Action.Settle;
        // Drawing waits for the coordinator's authenticated callback (§7.3 forbids re-requesting); Refunding is
        // the players' `claimRefund`; Settled and Void are terminal.
        return Action.None;
    }

    /// @dev `_stateAction` plus the VRF readiness gate that only `checkUpkeep` applies.
    function _offeredAction(ILuckyDraw.RoundView memory round) private view returns (Action action) {
        action = _stateAction(round);
        if (action == Action.RequestDraw && !requestReady()) return Action.None;
    }

    // ---------------------------------------------------------------------
    // Bounded scans
    // ---------------------------------------------------------------------

    /// @dev Phase 1: the current round of every kind of every pool in the page.
    function _scanCurrent(uint256 cursor, uint256 limit) private view returns (Action, uint256) {
        uint256 total = DRAW.poolCount();
        if (cursor >= total) return (Action.None, 0);
        uint256 size = total - cursor < limit ? total - cursor : limit;
        if (size == 0) return (Action.None, 0);

        (ILuckyDraw.PoolView[] memory page,) = DRAW.getPools(cursor, size);
        for (uint256 i = 0; i < page.length; ++i) {
            // A disabled pool is scanned too: disabling stops the *successor* (SPEC §6.1), it does not resolve
            // the round that is open right now, and that round still has to be closed.
            for (uint256 k = 0; k < KIND_COUNT; ++k) {
                uint256 roundId = DRAW.getCurrent(page[i].id, Kind(k));
                if (roundId == 0) continue;
                Action action = _offeredAction(DRAW.getRound(roundId));
                if (action != Action.None) return (action, roundId);
            }
        }
        return (Action.None, 0);
    }

    /// @dev Phase 2: a window of historical round identifiers, newest first.
    ///      Newest first because an unresolved round's request window is 24 hours wide and a freshly closed round
    ///      is the one whose deadline is closest; walking from the oldest identifier would spend the window on
    ///      long-settled rounds first.
    /// @param tail True when `checkData` was empty and the window should follow `roundCount`.
    function _scanHistory(bool tail, uint256 cursor, uint256 limit) private view returns (Action, uint256) {
        uint256 total = DRAW.roundCount();
        if (total == 0) return (Action.None, 0);
        uint256 start = tail ? (total > limit ? total - limit : 0) : cursor;
        if (start >= total) return (Action.None, 0);
        uint256 end = start + limit; // last id in the window, inclusive
        if (end > total) end = total;

        for (uint256 id = end; id > start; --id) {
            Action action = _offeredAction(DRAW.getRound(id));
            if (action != Action.None) return (action, id);
        }
        return (Action.None, 0);
    }

    /// @dev Decodes and clamps `checkData`. Malformed data is a registration mistake, so it reverts rather than
    ///      silently scanning something else.
    function _page(bytes calldata checkData)
        private
        pure
        returns (uint256 poolCursor, uint256 poolLimit, uint256 roundCursor, uint256 roundLimit)
    {
        if (checkData.length != 0) {
            (poolCursor, poolLimit, roundCursor, roundLimit) =
                abi.decode(checkData, (uint256, uint256, uint256, uint256));
        }
        if (poolLimit == 0 || poolLimit > MAX_POOL_PAGE) poolLimit = MAX_POOL_PAGE;
        if (roundLimit == 0 || roundLimit > MAX_ROUND_PAGE) roundLimit = MAX_ROUND_PAGE;
    }
}
