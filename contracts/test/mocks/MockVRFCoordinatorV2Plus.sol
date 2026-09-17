// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVRFCoordinatorV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import {IVRFSubscriptionV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFSubscriptionV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

import {IVRFCoordinatorV2_5Views} from "../../src/interfaces/IVRFCoordinatorV2_5Views.sol";
import {ImmutableVRFConsumer} from "../../src/lib/ImmutableVRFConsumer.sol";

/// @notice Settable VRF v2.5 coordinator mock. Labeled mock: test only, never deploy.
/// @dev Models the request/fulfil behaviour LuckyDraw depends on, verified against `chainlink-brownie-contracts`
///      v1.3.0 commit 5cb41fbc9b525338b6098da5ea7dd0b7e92f89e4:
///      - request time validates the subscription and the consumer but, per the in-source comment at
///        `VRFCoordinatorV2_5.sol:283`, deliberately does NOT validate the key hash, and does not check the
///        subscription balance either (billing happens in `_chargePayment`, line 514). This mock matches that: an
///        unregistered key hash and a zero balance both produce an accepted request that is simply never fulfilled,
///        which is what makes the SPEC §6.2 pre-checks necessary (A42).
///      - delivery mirrors `_deliverRandomness` (line 409): the coordinator calls
///        `rawFulfillRandomWords(uint256,uint256[])` on the recorded requester with exactly the recorded
///        `callbackGasLimit` and records the boolean outcome; a reverting or out-of-gas consumer does not revert the
///        fulfilment transaction and is never retried (SPEC §7.3).
///      Real delivery is asynchronous; tests drive it explicitly with `fulfill`.
///      Inheriting `IVRFCoordinatorV2Plus` is intentional: it makes the compiler prove that every signature this mock
///      answers matches the pinned upstream ABI.
contract MockVRFCoordinatorV2Plus is IVRFCoordinatorV2Plus, IVRFCoordinatorV2_5Views {
    struct ProvingKey {
        bool exists;
        uint64 maxGas;
    }

    struct Subscription {
        bool exists;
        uint96 linkBalance;
        uint96 nativeBalance;
        uint64 reqCount;
        address owner;
        address[] consumers;
    }

    struct Request {
        address requester;
        uint256 subId;
        bytes32 keyHash;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
        bool fulfilled;
        bool callbackSucceeded;
    }

    error UnknownSubscription(uint256 subId);
    error InvalidConsumer(uint256 subId, address consumer);
    error UnknownRequest(uint256 requestId);
    error AlreadyFulfilled(uint256 requestId);
    error InsufficientGasForCallback(uint256 available, uint32 requested);
    error NotImplemented();

    event RandomWordsRequested(
        bytes32 indexed keyHash,
        uint256 indexed requestId,
        uint256 indexed subId,
        address requester,
        uint16 requestConfirmations,
        uint32 callbackGasLimit,
        uint32 numWords,
        bytes extraArgs
    );
    event RandomWordsFulfilled(uint256 indexed requestId, address indexed consumer, bool success, uint256 gasUsed);

    /// @notice Next request ID handed out; the real coordinator derives IDs from a hash, only uniqueness matters here.
    uint256 public nextRequestId = 1;
    /// @notice Next subscription ID handed out by `createSubscription`.
    uint256 public nextSubId = 1;
    /// @notice Gas consumed by the most recent callback, including the CALL opcode and calldata overhead.
    uint256 public lastCallbackGasUsed;

    mapping(bytes32 => ProvingKey) private _provingKeys;
    mapping(uint256 => Subscription) private _subscriptions;
    mapping(uint256 => mapping(address => bool)) private _isConsumer;
    mapping(uint256 => Request) private _requests;
    mapping(uint256 => uint256) private _pendingRequests;

    // ---- Proving key administration (test drivers) ----

    /// @notice Registers a gas lane so `s_provingKeys(keyHash).exists` is true.
    /// @param keyHash The gas lane hash.
    /// @param maxGas The lane's maximum gas price in wei.
    function registerKey(bytes32 keyHash, uint64 maxGas) external {
        _provingKeys[keyHash] = ProvingKey({exists: true, maxGas: maxGas});
    }

    /// @notice Deregisters a gas lane, mirroring `deregisterProvingKey`'s delete (A42).
    /// @param keyHash The gas lane hash.
    function deregisterKey(bytes32 keyHash) external {
        delete _provingKeys[keyHash];
    }

    /// @inheritdoc IVRFCoordinatorV2_5Views
    function s_provingKeys(bytes32 keyHash) external view override returns (bool exists, uint64 maxGas) {
        ProvingKey memory key = _provingKeys[keyHash];
        return (key.exists, key.maxGas);
    }

    // ---- Subscription management ----

    /// @inheritdoc IVRFSubscriptionV2Plus
    function createSubscription() external override returns (uint256 subId) {
        subId = nextSubId++;
        Subscription storage sub = _subscriptions[subId];
        sub.exists = true;
        sub.owner = msg.sender;
    }

    /// @inheritdoc IVRFSubscriptionV2Plus
    function addConsumer(uint256 subId, address consumer) external override {
        _requireSubscription(subId);
        if (_isConsumer[subId][consumer]) return;
        _isConsumer[subId][consumer] = true;
        _subscriptions[subId].consumers.push(consumer);
    }

    /// @inheritdoc IVRFSubscriptionV2Plus
    function removeConsumer(uint256 subId, address consumer) external override {
        _requireSubscription(subId);
        if (!_isConsumer[subId][consumer]) revert InvalidConsumer(subId, consumer);
        _isConsumer[subId][consumer] = false;
        address[] storage consumers = _subscriptions[subId].consumers;
        uint256 length = consumers.length;
        for (uint256 i = 0; i < length; ++i) {
            if (consumers[i] == consumer) {
                consumers[i] = consumers[length - 1];
                consumers.pop();
                break;
            }
        }
    }

    /// @notice Sets the subscription's native balance directly, without transferring value.
    /// @dev Test driver for A42: lets a suite drop a funded subscription below the §6.2 threshold between close and
    ///      request without simulating a coordinator payment.
    /// @param subId The subscription ID.
    /// @param nativeBalance The new native balance in wei.
    function fundNative(uint256 subId, uint96 nativeBalance) external {
        _requireSubscription(subId);
        _subscriptions[subId].nativeBalance = nativeBalance;
    }

    /// @inheritdoc IVRFSubscriptionV2Plus
    function fundSubscriptionWithNative(uint256 subId) external payable override {
        _requireSubscription(subId);
        _subscriptions[subId].nativeBalance += uint96(msg.value);
    }

    /// @inheritdoc IVRFCoordinatorV2_5Views
    function getSubscription(uint256 subId)
        external
        view
        override(IVRFSubscriptionV2Plus, IVRFCoordinatorV2_5Views)
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] memory consumers)
    {
        Subscription storage sub = _subscriptions[subId];
        return (sub.linkBalance, sub.nativeBalance, sub.reqCount, sub.owner, sub.consumers);
    }

    /// @inheritdoc IVRFSubscriptionV2Plus
    function pendingRequestExists(uint256 subId) external view override returns (bool) {
        return _pendingRequests[subId] > 0;
    }

    /// @notice Not modelled: SPEC §7.3 forbids this deployment from ever calling it.
    function cancelSubscription(uint256, address) external pure override {
        revert NotImplemented();
    }

    /// @notice Not modelled: SPEC §7.3 forbids subscription owner transfer outside a recorded wind-down.
    function acceptSubscriptionOwnerTransfer(uint256) external pure override {
        revert NotImplemented();
    }

    /// @notice Not modelled: SPEC §7.3 forbids subscription owner transfer outside a recorded wind-down.
    function requestSubscriptionOwnerTransfer(uint256, address) external pure override {
        revert NotImplemented();
    }

    /// @notice Not modelled: enumeration is never used on-chain by LuckyDraw.
    function getActiveSubscriptionIds(uint256, uint256) external pure override returns (uint256[] memory) {
        revert NotImplemented();
    }

    // ---- Requests ----

    /// @inheritdoc IVRFCoordinatorV2Plus
    /// @dev Validates only the subscription and the consumer, exactly like the real coordinator. An unregistered key
    ///      hash or a zero native balance is accepted here and produces a request that is never fulfilled.
    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external
        override
        returns (uint256 requestId)
    {
        _requireSubscription(req.subId);
        if (!_isConsumer[req.subId][msg.sender]) revert InvalidConsumer(req.subId, msg.sender);

        requestId = nextRequestId++;
        _requests[requestId] = Request({
            requester: msg.sender,
            subId: req.subId,
            keyHash: req.keyHash,
            requestConfirmations: req.requestConfirmations,
            callbackGasLimit: req.callbackGasLimit,
            numWords: req.numWords,
            extraArgs: req.extraArgs,
            fulfilled: false,
            callbackSucceeded: false
        });
        ++_pendingRequests[req.subId];

        emit RandomWordsRequested(
            req.keyHash,
            requestId,
            req.subId,
            msg.sender,
            req.requestConfirmations,
            req.callbackGasLimit,
            req.numWords,
            req.extraArgs
        );
    }

    /// @notice Reads a recorded request.
    /// @param requestId The request ID.
    /// @return request The recorded request, including the raw `extraArgs` bytes for encoding assertions.
    function getRequest(uint256 requestId) external view returns (Request memory request) {
        return _requests[requestId];
    }

    // ---- Fulfilment (test driver) ----

    /// @notice Delivers `words` to the recorded requester with exactly the recorded callback gas limit.
    /// @dev Mirrors `VRFCoordinatorV2_5._deliverRandomness`: a low-level call whose boolean result is recorded, so a
    ///      reverting or out-of-gas consumer never reverts this transaction and is never retried. Word count is not
    ///      forced to match `numWords`, which lets tests deliver malformed payloads (A21).
    /// @param requestId The request to fulfil.
    /// @param words The words to deliver; zero words are valid data (A22).
    /// @return success Whether the consumer callback succeeded.
    function fulfill(uint256 requestId, uint256[] memory words) external returns (bool success) {
        Request storage request = _requests[requestId];
        address consumer = request.requester;
        if (consumer == address(0)) revert UnknownRequest(requestId);
        if (request.fulfilled) revert AlreadyFulfilled(requestId);

        uint32 limit = request.callbackGasLimit;
        uint256 available = gasleft();
        // Mirrors _callWithExactGas: refuse to deliver unless the full requested budget can actually be forwarded.
        if (available - available / 64 <= limit) revert InsufficientGasForCallback(available, limit);

        request.fulfilled = true;
        --_pendingRequests[request.subId];
        ++_subscriptions[request.subId].reqCount;

        bytes memory payload =
            abi.encodeWithSelector(ImmutableVRFConsumer.rawFulfillRandomWords.selector, requestId, words);
        uint256 gasBefore = gasleft();
        // solhint-disable-next-line avoid-low-level-calls
        (success,) = consumer.call{gas: limit}(payload);
        uint256 gasUsed = gasBefore - gasleft();

        request.callbackSucceeded = success;
        lastCallbackGasUsed = gasUsed;
        emit RandomWordsFulfilled(requestId, consumer, success, gasUsed);
    }

    // ---- Internals ----

    /// @notice Reverts unless the subscription exists, mirroring `_requireValidSubscription`.
    /// @param subId The subscription ID.
    function _requireSubscription(uint256 subId) internal view {
        if (!_subscriptions[subId].exists) revert UnknownSubscription(subId);
    }
}
