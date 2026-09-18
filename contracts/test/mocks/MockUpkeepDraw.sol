// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {Kind, KIND_COUNT, State} from "../../src/Types.sol";

/// @notice A labeled stand-in for `LuckyDraw`, used only where a real Draw cannot answer the question.
/// @dev Two questions need it, and nothing else in the upkeep suite does:
///        1. rotation coverage at a realistic sequence length -- a `roundCount` of 1,000 costs about a thousand
///           real closes on the production Draw, which is minutes of test time to prove an arithmetic property;
///        2. the `performUpkeep` revalidation guard, which the production Draw hides because it reverts with the
///           same `WrongState` selector the guard does. This Draw records the call and does *not* revert, so the
///           guard is the only thing standing between `performUpkeep` and a Draw method.
///      It implements exactly the five view selectors `checkUpkeep` reads plus the four lifecycle selectors
///      `performUpkeep` dispatches on; every other part of the Draw is absent on purpose.
contract MockUpkeepDraw {
    uint256 public poolCount;
    uint256 public roundCount;

    /// @notice Round ids this Draw reports as `Open` and past their cutoff, so `CloseRound` is due on them.
    mapping(uint256 => bool) public due;
    /// @notice `getCurrent(poolId, kind)`.
    mapping(uint256 => mapping(uint256 => uint256)) public current;

    /// @notice How often each lifecycle method was reached, per round.
    mapping(uint256 => uint256) public closeRoundCalls;
    uint256 public requestDrawCalls;
    uint256 public expireUnrequestedCalls;
    uint256 public settleCalls;

    function setCounts(uint256 pools, uint256 rounds) external {
        poolCount = pools;
        roundCount = rounds;
    }

    function setDue(uint256 roundId, bool value) external {
        due[roundId] = value;
    }

    function setCurrent(uint256 poolId, Kind kind, uint256 roundId) external {
        current[poolId][uint256(kind)] = roundId;
    }

    function getCurrent(uint256 poolId, Kind kind) external view returns (uint256) {
        return current[poolId][uint256(kind)];
    }

    function getPools(uint256 cursor, uint256 limit)
        external
        view
        returns (ILuckyDraw.PoolView[] memory page, uint256 nextCursor)
    {
        uint256 total = poolCount;
        uint256 size = cursor >= total ? 0 : (total - cursor < limit ? total - cursor : limit);
        page = new ILuckyDraw.PoolView[](size);
        for (uint256 i = 0; i < size; ++i) {
            page[i].id = cursor + i + 1;
            page[i].enabled = true;
        }
        nextCursor = cursor + size;
    }

    /// @dev A due round is `Open` with a cutoff of zero, which is in the past at every block; anything else is
    ///      `Settled`, which is terminal and offers nothing.
    function getRound(uint256 roundId) external view returns (ILuckyDraw.RoundView memory round) {
        round.id = roundId;
        round.state = due[roundId] ? State.Open : State.Settled;
    }

    function closeRound(uint256 roundId) external {
        ++closeRoundCalls[roundId];
    }

    function requestDraw(uint256) external {
        ++requestDrawCalls;
    }

    function expireUnrequested(uint256) external {
        ++expireUnrequestedCalls;
    }

    function settle(uint256) external {
        ++settleCalls;
    }

    /// @dev Kept so the fixed-size `targetUsd` member of `PoolView` cannot be optimised away by a future edit.
    function kindCount() external pure returns (uint256) {
        return KIND_COUNT;
    }
}
