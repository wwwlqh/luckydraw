// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILuckyVault} from "../../src/interfaces/ILuckyVault.sol";
import {ReleaseReason} from "../../src/Types.sol";

/// @notice Minimal stand-in for LuckyDraw so tests can reach the Vault's Draw-only methods (A43, A50).
/// @dev Labeled mock: never deploy to mainnet. Every method is a bare pass-through with no guards of its
///      own, so it doubles as the "faulty Draw" of SPEC §11.3: whatever the Vault rejects here is rejected
///      by the Vault alone, not by Draw-side discipline. The `try*` helpers attempt operations a Draw must
///      never be able to perform (owner configuration, user money movement, arbitrary calls).
contract MockDrawCaller {
    ILuckyVault public immutable vault;

    constructor(address vault_) {
        vault = ILuckyVault(vault_);
    }

    // ---- Honest Draw surface -------------------------------------------------

    function registerRound(uint256 id, address asset, uint64 closesAt) external {
        vault.registerRound(id, asset, closesAt);
    }

    function lock(uint256 id, address buyer, uint256 amount) external {
        vault.lock(id, buyer, amount);
    }

    function lockSeed(uint256 id, address account, uint256 amount) external {
        vault.lockSeed(id, account, amount);
    }

    function closeEscrow(uint256 id) external {
        vault.closeEscrow(id);
    }

    function release(uint256 id, address recipient, uint256 amount, ReleaseReason reason) external {
        vault.release(id, recipient, amount, reason);
    }

    // ---- Faulty Draw: operations the Vault must refuse ------------------------

    function tryListAsset(address asset, uint8 tokenDecimals) external {
        vault.listAsset(asset, tokenDecimals);
    }

    function trySetDepositsEnabled(address asset, bool enabled) external {
        vault.setDepositsEnabled(asset, enabled);
    }

    function trySetDepositsPaused(bool paused) external {
        vault.setDepositsPaused(paused);
    }

    function trySetDraw(address draw_) external {
        vault.setDraw(draw_);
    }

    function tryWithdraw(address asset, uint256 amount) external {
        vault.withdraw(asset, amount);
    }

    function tryAuthorizeSeed(address asset, uint256 maxPerRound) external {
        vault.authorizeSeed(asset, maxPerRound);
    }

    /// @notice Arbitrary call into the Vault, for probing selectors the typed helpers do not cover.
    function rawCall(bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = address(vault).call(data);
    }
}
