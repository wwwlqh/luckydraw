// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AggregatorV3Interface} from "@chainlink/contracts/src/v0.8/shared/interfaces/AggregatorV3Interface.sol";

/// @notice Settable AggregatorV3 mock for PriceReader and Draw tests (SPEC §3.2, A10, A40, A44). Labeled mock.
contract MockAggregatorV3 is AggregatorV3Interface {
    uint8 private _decimals;
    uint80 public roundId_;
    int256 public answer_;
    uint256 public updatedAt_;
    bool public revertLatest;
    bool public revertDecimals;

    constructor(uint8 decimals_) {
        _decimals = decimals_;
    }

    function set(uint80 roundId, int256 answer, uint256 updatedAt) external {
        roundId_ = roundId;
        answer_ = answer;
        updatedAt_ = updatedAt;
    }

    function setDecimals(uint8 d) external {
        _decimals = d;
    }

    function setRevert(bool latest, bool decimalsCall) external {
        revertLatest = latest;
        revertDecimals = decimalsCall;
    }

    function decimals() external view override returns (uint8) {
        if (revertDecimals) revert("MockAggregatorV3: decimals reverted");
        return _decimals;
    }

    function description() external pure override returns (string memory) {
        return "MOCK / USD";
    }

    function version() external pure override returns (uint256) {
        return 4;
    }

    function getRoundData(uint80) external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId_, answer_, updatedAt_, updatedAt_, roundId_);
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (revertLatest) revert("MockAggregatorV3: latestRoundData reverted");
        return (roundId_, answer_, updatedAt_, updatedAt_, roundId_);
    }
}
