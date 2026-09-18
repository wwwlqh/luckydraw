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

    /// @notice Pools whose current rounds one `checkUpkeep` scans (`POOLS_PER_CHECK * KIND_COUNT` `getRound`
    ///         calls, 28 at seven kinds).
    /// @dev Sized against a stated budget of 8,000,000 gas, 20% under the 10,000,000 `checkGasLimit` that
    ///      Chainlink Automation publishes for BNB Chain 56 and 97 (docs.chain.link, Automation → Supported
    ///      Networks, read 2026-09-18). Measured against the production Draw with cold storage, nothing due and
    ///      both maxima in force (`LuckyDrawUpkeepGasTest`, `gasleft()` around the first call of each test):
    ///      1,743,623 gas for 28 current rounds, 5,333,673 for 96 historical identifiers (55,559 each), so
    ///      7,077,296 in the worst case where the two pages do not overlap, and 5,984,731 for the default
    ///      rotating call on the reference fixture, where they do. Both are inside the 8,000,000 budget.
    ///      Four is also inside the Draw's own 1..100 page limit (`LuckyDraw.MAX_PAGE`), so `getPools` can never
    ///      revert `InvalidAmount` here.
    uint256 public constant POOLS_PER_CHECK = 4;

    /// @notice Historical round identifiers one `checkUpkeep` scans.
    /// @dev The historical sweep exists because `closeRound` advances `current` in the same transaction, so a
    ///      round that still needs a request, an expiry or a settlement stops being any pool's current round the
    ///      moment it closes (the same gap `keeper/src/keeper.ts` covers with its in-memory `tracked` set). Round
    ///      identifiers are a dense *global* sequence across every pool and kind (`LuckyDraw.roundId =
    ///      ++roundCount`), so the sweep is a window over that one range and needs no log scan -- but also so
    ///      that a fixed window is a shrinking amount of *time* as pools are added: sixteen pools of seven kinds
    ///      mint 112 identifiers a day, and any fixed window would starve everything behind it. `ROTATE_BLOCKS`
    ///      is the answer to that, not a bigger number here.
    uint256 public constant ROUNDS_PER_CHECK = 96;

    /// @notice Blocks each rotation page is held before `checkUpkeep` moves to the next one.
    /// @dev The page index is derived from `block.number`, so successive blocks walk every page and every round
    ///      is reached however long the sequence grows -- no round is starved behind a fixed newest-first window
    ///      (the failure this constant exists to prevent). At BSC's ~3-second blocks, 20 blocks is about one
    ///      minute per page, so *every* identifier is covered within
    ///      `ceil(roundCount / ROUNDS_PER_CHECK) * ROTATE_BLOCKS * 3` seconds: about 1 minute at 96 rounds,
    ///      11 minutes at 1,000 and 105 minutes at 10,000. An operator who may be offline longer than a cutoff
    ///      can tolerate registers a second upkeep with an explicit `checkData` cursor pinned to one page
    ///      (`docs/runbooks/testnet-launch.md` §4b).
    uint256 public constant ROTATE_BLOCKS = 20;

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
    ///        1. the current round of every `Kind` of every pool in this call's pool page, which is where a due
    ///           `closeRound` almost always is;
    ///        2. one page of historical round identifiers, which is where a round that closed but was never
    ///           requested, expired or settled ends up.
    ///      Both phases are bounded by the constants above and by nothing else, so a growing `poolCount` or
    ///      `roundCount` cannot turn this into an unbounded scan and the call stays inside the registry's
    ///      `checkGasLimit`.
    ///
    ///      With empty `checkData` the *page index of each phase rotates with `block.number`*:
    ///      `(block.number / ROTATE_BLOCKS) % pageCount`, computed separately for the pool list and for the
    ///      round sequence, so successive blocks walk every page of both. Coverage is therefore complete rather
    ///      than recent: an unresolved round is reached within
    ///      `ceil(roundCount / ROUNDS_PER_CHECK) * ROTATE_BLOCKS` blocks whatever its identifier. Page 0 of the
    ///      round sequence is the newest `ROUNDS_PER_CHECK` identifiers and each page walks its own ids
    ///      downwards, so the freshest rounds -- the ones whose 24-hour request window is closest -- are still
    ///      seen first within every rotation.
    ///
    ///      `requestDraw` additionally reproduces the two SPEC §6.2 pre-checks the Draw itself performs -- the
    ///      gas lane is still registered and the subscription's native balance covers `(pendingRequests + 1)`
    ///      requests -- and reports no action for that round when either fails, so an upkeep is not spent on a
    ///      transaction that would certainly revert. The round is not lost: it stays `AwaitingRequest` and this
    ///      contract offers `expireUnrequested` on it once its deadline passes.
    /// @param checkData Empty for the rotating pages described above, or
    ///        `abi.encode(poolCursor, poolLimit, roundCursor, roundLimit)` to pin one fixed page instead --
    ///        the override for an operator who wants a second registration nailed to a particular slice.
    ///        `poolCursor` and `roundCursor` are zero-based offsets; the limits are clamped to the constants
    ///        above, and a zero limit means the constant. The historical window is round ids
    ///        `roundCursor+1 .. roundCursor+roundLimit`, and nothing about it rotates.
    /// @return upkeepNeeded True when `performData` names an action.
    /// @return performData `abi.encode(Action, roundId)`; `(Action.None, 0)` when nothing is due.
    function checkUpkeep(bytes calldata checkData)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        Action action;
        uint256 roundId;
        if (checkData.length == 0) {
            (action, roundId) = _scanRotating();
        } else {
            (uint256 poolCursor, uint256 poolLimit, uint256 roundCursor, uint256 roundLimit) = _page(checkData);
            (action, roundId) = _scanCurrent(poolCursor, poolLimit);
            uint256 total = DRAW.roundCount();
            // A cursor at or past the end is an empty window, not an error -- and checking it first keeps
            // `roundCursor + roundLimit` away from an overflow an operator could otherwise reach with a silly
            // cursor, which would revert the whole simulation instead of scanning nothing.
            if (action == Action.None && roundCursor < total) {
                uint256 end = roundCursor + roundLimit;
                (action, roundId) = _scanHistory(roundCursor, end > total ? total : end);
            }
        }

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

    /// @dev The default scan: one rotating pool page, then one rotating round page.
    function _scanRotating() private view returns (Action, uint256) {
        uint256 pools = DRAW.poolCount();
        (Action action, uint256 roundId) =
            _scanCurrent(_pageIndex(pools, POOLS_PER_CHECK) * POOLS_PER_CHECK, POOLS_PER_CHECK);
        if (action != Action.None) return (action, roundId);

        uint256 total = DRAW.roundCount();
        // Page 0 is the newest `ROUNDS_PER_CHECK` identifiers, page 1 the ones before them, and so on, so an
        // incomplete page is always the oldest one.
        uint256 skip = _pageIndex(total, ROUNDS_PER_CHECK) * ROUNDS_PER_CHECK;
        if (skip >= total) return (Action.None, 0);
        uint256 end = total - skip;
        return _scanHistory(end > ROUNDS_PER_CHECK ? end - ROUNDS_PER_CHECK : 0, end);
    }

    /// @dev Which page of `ceil(total / per)` this block belongs to. Blocks are the only clock a `view` has that
    ///      advances on its own, and the registry re-simulates `checkUpkeep` every block, so dividing by
    ///      `ROTATE_BLOCKS` holds each page long enough for a `performUpkeep` to be built, sent and included
    ///      before the page moves on.
    function _pageIndex(uint256 total, uint256 per) private view returns (uint256) {
        if (total <= per) return 0;
        return (block.number / ROTATE_BLOCKS) % ((total + per - 1) / per);
    }

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

    /// @dev Phase 2: round identifiers `start+1 .. end`, walked newest first.
    ///      Newest first because an unresolved round's request window is 24 hours wide and a freshly closed round
    ///      is the one whose deadline is closest; walking from the oldest identifier would spend the page on
    ///      long-settled rounds first.
    /// @param start Exclusive lower bound of the window.
    /// @param end Inclusive upper bound, already clamped to `roundCount` by the caller.
    function _scanHistory(uint256 start, uint256 end) private view returns (Action, uint256) {
        for (uint256 id = end; id > start; --id) {
            Action action = _offeredAction(DRAW.getRound(id));
            if (action != Action.None) return (action, id);
        }
        return (Action.None, 0);
    }

    /// @dev Decodes and clamps an explicit `checkData` page. Malformed data is a registration mistake, so it
    ///      reverts rather than silently scanning something else.
    function _page(bytes calldata checkData)
        private
        pure
        returns (uint256 poolCursor, uint256 poolLimit, uint256 roundCursor, uint256 roundLimit)
    {
        (poolCursor, poolLimit, roundCursor, roundLimit) = abi.decode(checkData, (uint256, uint256, uint256, uint256));
        if (poolLimit == 0 || poolLimit > POOLS_PER_CHECK) poolLimit = POOLS_PER_CHECK;
        if (roundLimit == 0 || roundLimit > ROUNDS_PER_CHECK) roundLimit = ROUNDS_PER_CHECK;
    }
}
