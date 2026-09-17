// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReleaseReason} from "../Types.sol";

/// @notice Custody, balances and per-round escrow (SPEC §4). No game logic, no price reads, no oracle calls.
/// @dev Every mutation runs under one Vault reentrancy guard. Native BNB is address(0).
interface ILuckyVault {
    struct AssetRecord {
        bool listed;
        uint8 tokenDecimals;
        bool depositsEnabled;
    }

    struct Escrow {
        address asset;
        uint256 amount;
        uint64 closesAt;
        bool registered;
        bool closed;
        bool released;
    }

    // ---- Events (SPEC §8.2) ----
    event Deposited(address indexed user, address indexed asset, uint256 amount);
    event Withdrawn(address indexed user, address indexed asset, uint256 amount);
    event RoundRegistered(uint256 indexed roundId, address indexed asset);
    event FundsLocked(uint256 indexed roundId, address indexed user, address indexed asset, uint256 gross);
    event FundsReleased(
        uint256 indexed roundId, address indexed recipient, address indexed asset, uint256 amount, ReleaseReason reason
    );
    event RoundEscrowClosed(uint256 indexed roundId);
    event AssetListed(address indexed asset, uint8 tokenDecimals);
    event DepositsEnabledSet(address indexed asset, address actor, bool oldValue, bool newValue);
    event DepositsPausedSet(address actor, bool oldValue, bool newValue);
    event DrawBound(address indexed draw, address actor);
    event SeedAuthorized(
        address indexed account, address indexed asset, uint256 oldMaxPerRound, uint256 newMaxPerRound
    );

    // ---- User (SPEC §4.2) ----
    function depositNative() external payable;
    function deposit(address asset, uint256 amount) external;
    function withdraw(address asset, uint256 amount) external;
    /// @notice The seed Safe's own consent, per asset: the most any single round in `asset` may take from
    ///         it, in that asset's raw units; 0 revokes that asset. Reverts `InvalidAsset` if unlisted.
    function authorizeSeed(address asset, uint256 maxPerRound) external;

    // ---- Draw only (SPEC §4.2, V5) ----
    function registerRound(uint256 id, address asset, uint64 closesAt) external;
    function lock(uint256 id, address buyer, uint256 amount) external;
    function lockSeed(uint256 id, address account, uint256 amount) external;
    function closeEscrow(uint256 id) external;
    function release(uint256 id, address recipient, uint256 amount, ReleaseReason reason) external;

    // ---- Owner (SPEC §8.1) ----
    function listAsset(address asset, uint8 tokenDecimals) external;
    function setDepositsEnabled(address asset, bool enabled) external;
    function setDepositsPaused(bool paused) external;
    function setDraw(address draw_) external;

    // ---- Views ----
    function draw() external view returns (address);
    function depositsPaused() external view returns (bool);
    function balanceOf(address user, address asset) external view returns (uint256);
    function totalAvailable(address asset) external view returns (uint256);
    function totalEscrow(address asset) external view returns (uint256);
    function getEscrow(uint256 id) external view returns (Escrow memory);
    function getAsset(address asset) external view returns (AssetRecord memory);
    function lockedBy(uint256 id, address user) external view returns (uint256);
    function refundedTo(uint256 id, address user) external view returns (uint256);
    function seedMaxPerRound(address account, address asset) external view returns (uint256);
    function seedLocked(uint256 id, address account) external view returns (uint256);
}
