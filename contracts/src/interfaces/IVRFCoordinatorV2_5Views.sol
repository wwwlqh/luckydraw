// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The two VRF v2.5 coordinator view functions LuckyDraw depends on (SPEC §6.2 pre-checks, §7.1).
/// @dev Declared locally because the pinned upstream package exposes neither getter on an interface that is safe to
///      depend on: `s_provingKeys` is only the public mapping getter of the concrete coordinator, and
///      `getSubscription` lives on `IVRFSubscriptionV2Plus` together with eight mutating subscription functions
///      (cancelSubscription, removeConsumer, subscription owner transfer) that SPEC §7.3 forbids for the life of this
///      deployment. Binding the Draw to a view-only interface keeps those selectors out of its ABI surface.
///
///      Verified against `chainlink-brownie-contracts` v1.3.0, commit 5cb41fbc9b525338b6098da5ea7dd0b7e92f89e4:
///      - `contracts/src/v0.8/vrf/dev/VRFCoordinatorV2_5.sol:45-50` declares
///        `struct ProvingKey {bool exists; uint64 maxGas;}` and
///        `mapping(bytes32 => ProvingKey) public s_provingKeys;`, so the compiler-generated getter is exactly
///        `s_provingKeys(bytes32) returns (bool exists, uint64 maxGas)`.
///      - `contracts/src/v0.8/vrf/dev/interfaces/IVRFSubscriptionV2Plus.sol:67` declares `getSubscription` with the
///        five-value return tuple reproduced below; `VRFCoordinatorV2_5` inherits it through `SubscriptionAPI`.
///
///      SPEC §6.2 requires confirming both signatures against the deployed BSC coordinator's ABI at deployment
///      (§15 checklist); a coordinator that lacks either getter must fail deployment rather than be adapted here.
interface IVRFCoordinatorV2_5Views {
    /// @notice Reports whether a gas lane (proving key) is registered on the coordinator and its gas price ceiling.
    /// @param keyHash The proving key hash of the gas lane.
    /// @return exists True when the coordinator will fulfil requests made against this key hash.
    /// @return maxGas The lane's maximum gas price in wei used by the coordinator when validating a fulfilment.
    function s_provingKeys(bytes32 keyHash) external view returns (bool exists, uint64 maxGas);

    /// @notice Reads a subscription's balances, request count, owner and consumer set.
    /// @param subId The subscription ID.
    /// @return balance LINK balance in juels.
    /// @return nativeBalance Native (BNB on BSC) balance in wei; the only field LuckyDraw bills against (§7.1).
    /// @return reqCount Number of fulfilled requests charged to the subscription.
    /// @return owner The subscription owner, which SPEC §7.3 requires to be the operator multisig.
    /// @return consumers Addresses allowed to request randomness against the subscription.
    function getSubscription(uint256 subId)
        external
        view
        returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] memory consumers);
}
