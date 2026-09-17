// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

import {InvalidConfig, Unauthorized} from "../../src/Errors.sol";
import {MockVRFCoordinatorV2Plus} from "../mocks/MockVRFCoordinatorV2Plus.sol";
import {SampleConsumer} from "../mocks/SampleConsumer.sol";

/// @notice Unit tests for the VRF v2.5 authentication adapter (SPEC §6.2, §7.1, §11.2; A16, A21, A22, A42).
contract ImmutableVRFConsumerTest is Test {
    MockVRFCoordinatorV2Plus internal coordinator;
    SampleConsumer internal consumer;
    uint256 internal subId;

    bytes32 internal constant KEY_HASH = keccak256("luckydraw.test.lane");
    bytes32 internal constant OTHER_KEY_HASH = keccak256("luckydraw.test.other-lane");
    uint16 internal constant CONFIRMATIONS = 200;
    uint32 internal constant CALLBACK_GAS_LIMIT = 300_000;
    uint32 internal constant NUM_WORDS = 2;
    /// @dev SPEC §11.2: worst valid callback must stay at or below 150,000 consumer gas.
    uint256 internal constant CALLBACK_GAS_TARGET = 150_000;

    address internal constant STRANGER = address(0xBAD);

    function setUp() public {
        coordinator = new MockVRFCoordinatorV2Plus();
        consumer = new SampleConsumer(address(coordinator));
        subId = coordinator.createSubscription();
        coordinator.addConsumer(subId, address(consumer));
        coordinator.registerKey(KEY_HASH, 100 gwei);
        coordinator.fundNative(subId, 1 ether);
    }

    // ---- Construction (SPEC §7.1: coordinator fixed at construction) ----

    function test_Constructor_StoresCoordinator() public view {
        assertEq(address(consumer.VRF_COORDINATOR()), address(coordinator));
    }

    function test_Constructor_RevertsOnZeroCoordinator() public {
        vm.expectRevert(InvalidConfig.selector);
        new SampleConsumer(address(0));
    }

    function test_Constructor_RevertsOnCodelessCoordinator() public {
        address codeless = address(0xC0DE1E55);
        assertEq(codeless.code.length, 0);
        vm.expectRevert(InvalidConfig.selector);
        new SampleConsumer(codeless);
    }

    // ---- Callback authentication (SPEC §7.1, A21) ----

    function test_RawFulfillRandomWords_RevertsForNonCoordinator() public {
        uint256[] memory words = _words(1, 2);
        vm.prank(STRANGER);
        vm.expectRevert(Unauthorized.selector);
        consumer.rawFulfillRandomWords(1, words);
        assertEq(consumer.callbackCount(), 0);
    }

    function test_RawFulfillRandomWords_RevertsForSelfCall() public {
        uint256[] memory words = _words(1, 2);
        vm.prank(address(consumer));
        vm.expectRevert(Unauthorized.selector);
        consumer.rawFulfillRandomWords(1, words);
    }

    function test_RawFulfillRandomWords_DispatchesOnceFromCoordinator() public {
        uint256 requestId = _request();
        bool success = coordinator.fulfill(requestId, _words(11, 22));

        assertTrue(success);
        assertEq(consumer.callbackCount(), 1);
        assertEq(consumer.lastRequestId(), requestId);
        assertEq(consumer.word0(), 11);
        assertEq(consumer.word1(), 22);
        assertTrue(coordinator.getRequest(requestId).callbackSucceeded);
    }

    function test_RawFulfillRandomWords_ZeroWordsAreValidData() public {
        uint256 requestId = _request();
        assertTrue(coordinator.fulfill(requestId, _words(0, 0)));

        assertEq(consumer.callbackCount(), 1);
        assertEq(consumer.lastWordCount(), 2);
        assertEq(consumer.word0(), 0);
        assertEq(consumer.word1(), 0);
    }

    /// @dev The adapter must not filter malformed payloads; the Draw emits CallbackIgnored instead (SPEC §7.1).
    function test_RawFulfillRandomWords_MalformedWordCountReachesConsumer() public {
        uint256 oneWordRequest = _request();
        uint256[] memory one = new uint256[](1);
        one[0] = 7;
        assertTrue(coordinator.fulfill(oneWordRequest, one));
        assertEq(consumer.lastWordCount(), 1);
        assertEq(consumer.word0(), 7);
        assertEq(consumer.word1(), 0);

        uint256 threeWordRequest = _request();
        uint256[] memory three = new uint256[](3);
        (three[0], three[1], three[2]) = (1, 2, 3);
        assertTrue(coordinator.fulfill(threeWordRequest, three));
        assertEq(consumer.lastWordCount(), 3);
        assertEq(consumer.callbackCount(), 2);
        assertTrue(coordinator.getRequest(threeWordRequest).callbackSucceeded);

        uint256 emptyRequest = _request();
        assertTrue(coordinator.fulfill(emptyRequest, new uint256[](0)));
        assertEq(consumer.lastWordCount(), 0);
        assertEq(consumer.callbackCount(), 3);
    }

    /// @dev SPEC §7.3: a failing callback is recorded as failed and never retried; it must not revert the coordinator.
    function test_RevertingConsumerDoesNotRevertFulfilment() public {
        uint256 requestId = _request();
        consumer.setRevertOnCallback(true);

        bool success = coordinator.fulfill(requestId, _words(1, 2));

        assertFalse(success);
        assertFalse(coordinator.getRequest(requestId).callbackSucceeded);
        assertTrue(coordinator.getRequest(requestId).fulfilled);
        assertEq(consumer.callbackCount(), 0);
    }

    // ---- Request encoding (SPEC §7.1) ----

    function test_RequestRandomWords_EncodesNativePaymentAndFixedParameters() public {
        uint256 requestId = _request();
        MockVRFCoordinatorV2Plus.Request memory request = coordinator.getRequest(requestId);

        assertEq(request.requester, address(consumer));
        assertEq(request.subId, subId);
        assertEq(request.keyHash, KEY_HASH);
        assertEq(request.requestConfirmations, CONFIRMATIONS);
        assertEq(request.callbackGasLimit, CALLBACK_GAS_LIMIT);
        assertEq(request.numWords, NUM_WORDS);

        bytes memory expected = VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: true}));
        assertEq(request.extraArgs, expected);
        assertEq(abi.encodePacked(bytes4(request.extraArgs)), abi.encodePacked(VRFV2PlusClient.EXTRA_ARGS_V1_TAG));
        // The coordinator reads native billing from the final byte of extraArgs (VRFCoordinatorV2_5.sol:490).
        assertEq(uint8(request.extraArgs[request.extraArgs.length - 1]), 1);
    }

    function test_RequestRandomWords_ReturnsSequentialUniqueIds() public {
        assertEq(_request(), 1);
        assertEq(_request(), 2);
        assertEq(_request(), 3);
    }

    /// @dev A42/§6.2: the coordinator accepts both, which is why requestDraw needs its own pre-checks.
    function test_RequestRandomWords_AcceptsUnregisteredKeyAndEmptySubscription() public {
        coordinator.deregisterKey(KEY_HASH);
        coordinator.fundNative(subId, 0);

        uint256 requestId = _request();

        assertEq(requestId, 1);
        assertFalse(consumer.keyHashRegistered(KEY_HASH));
        assertEq(consumer.subscriptionNativeBalance(subId), 0);
    }

    function test_RequestRandomWords_RevertsForUnknownSubscriptionOrNonConsumer() public {
        uint256 unknownSubId = 999;
        vm.expectRevert(abi.encodeWithSelector(MockVRFCoordinatorV2Plus.UnknownSubscription.selector, unknownSubId));
        consumer.requestRandomWords(KEY_HASH, unknownSubId, CONFIRMATIONS, CALLBACK_GAS_LIMIT, NUM_WORDS);

        SampleConsumer outsider = new SampleConsumer(address(coordinator));
        vm.expectRevert(
            abi.encodeWithSelector(MockVRFCoordinatorV2Plus.InvalidConsumer.selector, subId, address(outsider))
        );
        outsider.requestRandomWords(KEY_HASH, subId, CONFIRMATIONS, CALLBACK_GAS_LIMIT, NUM_WORDS);
    }

    // ---- Coordinator views used by the §6.2 pre-checks ----

    function test_KeyHashRegistered_TracksCoordinatorState() public {
        assertTrue(consumer.keyHashRegistered(KEY_HASH));
        assertFalse(consumer.keyHashRegistered(OTHER_KEY_HASH));

        coordinator.deregisterKey(KEY_HASH);
        assertFalse(consumer.keyHashRegistered(KEY_HASH));

        coordinator.registerKey(OTHER_KEY_HASH, 50 gwei);
        assertTrue(consumer.keyHashRegistered(OTHER_KEY_HASH));
    }

    function test_SubscriptionNativeBalance_TracksCoordinatorState() public {
        assertEq(consumer.subscriptionNativeBalance(subId), 1 ether);

        coordinator.fundNative(subId, 3 wei);
        assertEq(consumer.subscriptionNativeBalance(subId), 3);

        coordinator.fundSubscriptionWithNative{value: 1 wei}(subId);
        assertEq(consumer.subscriptionNativeBalance(subId), 4);

        // Unknown subscriptions read as zero, so an underfunded pre-check fails closed.
        assertEq(consumer.subscriptionNativeBalance(4242), 0);
    }

    // ---- No migration path (SPEC §7.1) ----

    /// @dev The adapter must expose no coordinator setter and none of the ConfirmedOwner surface that would make the
    ///      upstream base's non-virtual `setCoordinator` reachable.
    function test_NoCoordinatorSetterOrOwnershipSurfaceExists() public {
        string[5] memory signatures;
        signatures[0] = "setCoordinator(address)";
        signatures[1] = "s_vrfCoordinator()";
        signatures[2] = "owner()";
        signatures[3] = "transferOwnership(address)";
        signatures[4] = "acceptOwnership()";
        for (uint256 i = 0; i < signatures.length; ++i) {
            (bool ok,) = address(consumer).call(abi.encodeWithSignature(signatures[i], address(this)));
            assertFalse(ok, signatures[i]);
        }

        // Even the coordinator itself cannot repoint the consumer.
        vm.prank(address(coordinator));
        (bool coordinatorOk,) =
            address(consumer).call(abi.encodeWithSignature("setCoordinator(address)", address(this)));
        assertFalse(coordinatorOk);
        assertEq(address(consumer.VRF_COORDINATOR()), address(coordinator));
    }

    // ---- Gas (SPEC §11.2 Gas/scale) ----

    function test_CallbackGas_ColdNonzeroWords() public {
        SampleConsumer fresh = _freshConsumer();
        uint256 requestId = fresh.requestRandomWords(KEY_HASH, subId, CONFIRMATIONS, CALLBACK_GAS_LIMIT, NUM_WORDS);

        assertTrue(coordinator.fulfill(requestId, _words(type(uint256).max, 1)));
        uint256 used = coordinator.lastCallbackGasUsed();

        emit log_named_uint("callback gas (cold, nonzero words)", used);
        assertLt(used, CALLBACK_GAS_LIMIT);
        assertLt(used, CALLBACK_GAS_TARGET);
    }

    function test_CallbackGas_ColdZeroWords() public {
        SampleConsumer fresh = _freshConsumer();
        uint256 requestId = fresh.requestRandomWords(KEY_HASH, subId, CONFIRMATIONS, CALLBACK_GAS_LIMIT, NUM_WORDS);

        assertTrue(coordinator.fulfill(requestId, _words(0, 0)));
        uint256 used = coordinator.lastCallbackGasUsed();

        emit log_named_uint("callback gas (cold, zero words)", used);
        assertLt(used, CALLBACK_GAS_TARGET);
    }

    // ---- Helpers ----

    /// @notice Requests two words from the shared consumer with the SPEC §7.1 fixed parameters.
    /// @return requestId The coordinator's request ID.
    function _request() internal returns (uint256 requestId) {
        return consumer.requestRandomWords(KEY_HASH, subId, CONFIRMATIONS, CALLBACK_GAS_LIMIT, NUM_WORDS);
    }

    /// @notice Deploys a consumer with untouched storage and registers it on the subscription.
    /// @return fresh The new consumer.
    function _freshConsumer() internal returns (SampleConsumer fresh) {
        fresh = new SampleConsumer(address(coordinator));
        coordinator.addConsumer(subId, address(fresh));
    }

    /// @notice Builds a two-word array.
    /// @param a First word.
    /// @param b Second word.
    /// @return words The two-word array.
    function _words(uint256 a, uint256 b) internal pure returns (uint256[] memory words) {
        words = new uint256[](2);
        words[0] = a;
        words[1] = b;
    }
}
