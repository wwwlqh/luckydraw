// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ImmutableVRFConsumer} from "../../src/lib/ImmutableVRFConsumer.sol";

/// @notice Minimal concrete `ImmutableVRFConsumer` used to exercise and measure the adapter. Labeled mock: test only.
/// @dev Storage layout approximates LuckyDraw's callback work for the SPEC §11.2 gas budget: three cold word-sized
///      stores (request ID plus two words) and one packed counter slot. It is not the Draw: it performs no round
///      lookup and no state transition, so its measurement is a floor for the real callback, not a substitute.
contract SampleConsumer is ImmutableVRFConsumer {
    error CallbackRejected();

    /// @notice Request ID of the most recent authenticated delivery.
    uint256 public lastRequestId;
    /// @notice First delivered word, or zero when none was delivered.
    uint256 public word0;
    /// @notice Second delivered word, or zero when fewer than two were delivered.
    uint256 public word1;
    /// @notice Number of authenticated deliveries dispatched to `_fulfillRandomWords`.
    uint64 public callbackCount;
    /// @notice Word count of the most recent delivery, so tests can observe malformed payloads (A21).
    uint64 public lastWordCount;
    /// @notice When true the callback reverts, modelling a consumer that fails inside its fulfilment.
    bool public revertOnCallback;

    /// @param coordinator The coordinator address bound for the life of this consumer.
    constructor(address coordinator) ImmutableVRFConsumer(coordinator) {}

    /// @notice Makes the next callbacks revert, to prove the coordinator's fulfilment transaction still succeeds.
    /// @param shouldRevert Whether `_fulfillRandomWords` should revert.
    function setRevertOnCallback(bool shouldRevert) external {
        revertOnCallback = shouldRevert;
    }

    /// @notice Requests randomness through the adapter with caller-supplied parameters.
    /// @param keyHash The gas lane.
    /// @param subId The subscription ID.
    /// @param confirmations Request confirmations.
    /// @param callbackGasLimit Callback budget.
    /// @param numWords Number of words requested.
    /// @return requestId The coordinator's request ID.
    function requestRandomWords(
        bytes32 keyHash,
        uint256 subId,
        uint16 confirmations,
        uint32 callbackGasLimit,
        uint32 numWords
    ) external returns (uint256 requestId) {
        return _requestRandomWords(keyHash, subId, confirmations, callbackGasLimit, numWords);
    }

    /// @notice Exposes `_keyHashRegistered` for testing.
    /// @param keyHash The gas lane to check.
    /// @return registered Whether the coordinator reports the lane as registered.
    function keyHashRegistered(bytes32 keyHash) external view returns (bool registered) {
        return _keyHashRegistered(keyHash);
    }

    /// @notice Exposes `_subscriptionNativeBalance` for testing.
    /// @param subId The subscription ID.
    /// @return nativeBalance The subscription's native balance in wei.
    function subscriptionNativeBalance(uint256 subId) external view returns (uint256 nativeBalance) {
        return _subscriptionNativeBalance(subId);
    }

    /// @notice Records an authenticated delivery without validating it.
    /// @dev Accepts any word count on purpose: filtering is the Draw's job (SPEC §7.1), not the adapter's.
    /// @param requestId The coordinator's request ID.
    /// @param randomWords The delivered words.
    function _fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override {
        if (revertOnCallback) revert CallbackRejected();
        lastRequestId = requestId;
        callbackCount += 1;
        lastWordCount = uint64(randomWords.length);
        if (randomWords.length > 0) word0 = randomWords[0];
        if (randomWords.length > 1) word1 = randomWords[1];
    }
}
