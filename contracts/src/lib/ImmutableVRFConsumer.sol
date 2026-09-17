// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVRFCoordinatorV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

import {IVRFCoordinatorV2_5Views} from "../interfaces/IVRFCoordinatorV2_5Views.sol";
import {InvalidConfig, Unauthorized} from "../Errors.sol";

/// @title ImmutableVRFConsumer
/// @notice Minimal, migration-free Chainlink VRF v2.5 authentication adapter for LuckyDraw (SPEC §7.1).
/// @dev Deliberately in audit scope and deliberately tiny: it authenticates the coordinator callback, encodes the
///      request, and exposes the two coordinator views the §6.2 pre-checks need. It holds no draw state, moves no
///      funds and makes no policy decision; every ignore/accept rule lives in the inheriting Draw.
///
///      WHY THE UPSTREAM BASE IS NOT INHERITED (SPEC §7.1, "There is no migration setter"):
///      `VRFConsumerBaseV2Plus` (chainlink-brownie-contracts v1.3.0, commit
///      5cb41fbc9b525338b6098da5ea7dd0b7e92f89e4, `contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol`) stores the
///      coordinator in the mutable state variable `s_vrfCoordinator` (line 108) and exposes
///      `setCoordinator(address) external override onlyOwnerOrCoordinator` (line 150). That function is **not**
///      `virtual`, so an inheriting contract cannot override it away: promising to override it is impossible, and
///      disabling it would require deploying a modified copy of the base anyway. Inheriting it would also pull in
///      `ConfirmedOwner` and grant both the owner *and* the current coordinator authority to repoint the consumer at
///      an arbitrary address, which would let a single compromised key substitute the randomness source for pots that
///      have no economic cap. This contract therefore reimplements only the authentication path, with the coordinator
///      address `immutable` and no setter of any kind.
///
///      ADAPTATION DIFF versus the upstream base:
///      - `s_vrfCoordinator` (mutable storage) -> `VRF_COORDINATOR` (immutable), set once in the constructor;
///      - `setCoordinator`, `CoordinatorSet`, `IVRFMigratableConsumerV2Plus` and `ConfirmedOwner` removed entirely;
///      - constructor additionally rejects a coordinator address with no deployed code, not just address(0);
///      - `OnlyCoordinatorCanFulfill(have, want)` replaced by the shared `Unauthorized()` error (SPEC §8.1);
///      - `fulfillRandomWords` renamed `_fulfillRandomWords` to match this repo's internal naming;
///      - the external callback entry point `rawFulfillRandomWords(uint256, uint256[] calldata)` is byte-identical in
///        selector and semantics, which is what `VRFCoordinatorV2_5._deliverRandomness` (line 409-424) calls with
///        `abi.encodeWithSelector(v.rawFulfillRandomWords.selector, requestId, randomWords)` under
///        `_callWithExactGas(rc.callbackGasLimit, rc.sender, resp)`.
abstract contract ImmutableVRFConsumer {
    /// @notice The VRF v2.5 coordinator, fixed at construction. There is no setter and no migration path (§7.1).
    /// @dev Typed as the local view interface; request calls cast it to `IVRFCoordinatorV2Plus`.
    IVRFCoordinatorV2_5Views public immutable VRF_COORDINATOR;

    /// @notice Binds the consumer to one coordinator for the life of the deployment.
    /// @dev Reverts `InvalidConfig` for address(0) or an address with no code. The code check is a deployment-time
    ///      sanity guard only: a coordinator that is later selfdestructed or is the wrong contract cannot be
    ///      repaired here, and SPEC §7.3 accepts that as a disclosed limitation.
    /// @param coordinator The VRF v2.5 coordinator address for the target chain (SPEC §15 deployment parameters).
    constructor(address coordinator) {
        if (coordinator == address(0) || coordinator.code.length == 0) revert InvalidConfig();
        VRF_COORDINATOR = IVRFCoordinatorV2_5Views(coordinator);
    }

    /// @notice Coordinator callback entry point; authenticates the caller and dispatches once (SPEC §7.1).
    /// @dev Reverts `Unauthorized()` for any caller other than the immutable coordinator. Everything else --
    ///      unknown, duplicate or malformed deliveries, including a word count other than two -- is forwarded to
    ///      `_fulfillRandomWords` so the Draw can emit `CallbackIgnored` and return without changing outcome; this
    ///      adapter must not filter, because a silent revert here would be recorded by the coordinator as a failed
    ///      fulfilment that is never retried (§7.3). The guard is independent of any owner pause flag.
    /// @param requestId The coordinator's request ID.
    /// @param randomWords The delivered words; a zero word is valid data, not a missing-word marker (§7.1, A22).
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(VRF_COORDINATOR)) revert Unauthorized();
        _fulfillRandomWords(requestId, randomWords);
    }

    /// @notice Handles an authenticated delivery. Implemented by LuckyDraw.
    /// @dev Implementations must not revert on unknown/duplicate/malformed input and must stay inside the measured
    ///      callback budget of 150,000 gas against the 300,000 limit (SPEC §11.2 Gas/scale).
    /// @param requestId The coordinator's request ID.
    /// @param randomWords The delivered words, unvalidated.
    function _fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal virtual;

    /// @notice Requests random words with native (BNB) billing from the operator subscription.
    /// @dev Encodes `extraArgs` with `VRFV2PlusClient._argsToBytes(ExtraArgsV1({nativePayment: true}))`, the pinned
    ///      client encoding (`libraries/VRFV2PlusClient.sol:21-23`, tag `bytes4(keccak256("VRF ExtraArgsV1"))`).
    ///      The coordinator validates only the subscription, the consumer, confirmations, gas limit and word count at
    ///      request time -- `VRFCoordinatorV2_5.requestRandomWords` (line 249-283) states in-source that "we do not
    ///      check whether the keyHash is valid to save gas", and billing happens at fulfilment in `_chargePayment`
    ///      (line 514) -- so an unregistered key hash or an underfunded subscription is accepted here and simply
    ///      never fulfilled. The §6.2 pre-checks built on `_keyHashRegistered` and `_subscriptionNativeBalance` are
    ///      the only on-chain defence against that, and the caller (LuckyDraw.requestDraw) owns them, together with
    ///      rejecting a zero or already-used returned ID (`InvalidRequestId`) and rolling the whole transaction back
    ///      on failure. This helper deliberately adds no checks of its own.
    /// @param keyHash The constructor-fixed gas lane.
    /// @param subId The constructor-fixed subscription ID.
    /// @param confirmations Request confirmations (SPEC §7.1 fixes 200).
    /// @param callbackGasLimit Callback budget (SPEC §7.1 fixes 300,000).
    /// @param numWords Number of words (SPEC §7.1 fixes 2).
    /// @return requestId The coordinator's request ID; unvalidated by design.
    function _requestRandomWords(
        bytes32 keyHash,
        uint256 subId,
        uint16 confirmations,
        uint32 callbackGasLimit,
        uint32 numWords
    ) internal returns (uint256 requestId) {
        return IVRFCoordinatorV2Plus(address(VRF_COORDINATOR))
            .requestRandomWords(
                VRFV2PlusClient.RandomWordsRequest({
                    keyHash: keyHash,
                    subId: subId,
                    requestConfirmations: confirmations,
                    callbackGasLimit: callbackGasLimit,
                    numWords: numWords,
                    extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: true}))
                })
            );
    }

    /// @notice Reports whether the coordinator still has the gas lane registered (SPEC §6.2 `KeyHashUnsupported`).
    /// @dev Reads the coordinator's `s_provingKeys` getter; a deregistered lane returns `exists == false` because
    ///      `deregisterProvingKey` deletes the entry (`VRFCoordinatorV2_5.sol:124`).
    /// @param keyHash The gas lane to check.
    /// @return registered True when the coordinator would fulfil a request made against this key hash.
    function _keyHashRegistered(bytes32 keyHash) internal view returns (bool registered) {
        (registered,) = VRF_COORDINATOR.s_provingKeys(keyHash);
    }

    /// @notice Reads the subscription's native balance in wei (SPEC §6.2 `SubscriptionUnderfunded`).
    /// @dev Second element of the `getSubscription` tuple. Widened from `uint96` to `uint256` so the caller can
    ///      compare against `(pendingRequests + 1) * maxRequestCostNative` without an intermediate cast.
    /// @param subId The subscription ID.
    /// @return nativeBalance The subscription's native balance in wei.
    function _subscriptionNativeBalance(uint256 subId) internal view returns (uint256 nativeBalance) {
        (, uint96 balance,,,) = VRF_COORDINATOR.getSubscription(subId);
        return uint256(balance);
    }
}
