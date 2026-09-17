// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILuckyVault} from "../../src/interfaces/ILuckyVault.sol";

/// @notice Base helper: a contract wallet that can deposit into and withdraw from the Vault (A28, A27).
/// @dev Labeled mock: never deploy to mainnet.
abstract contract VaultClient {
    ILuckyVault public immutable vault;

    constructor(address vault_) {
        vault = ILuckyVault(vault_);
    }

    function depositNative(uint256 amount) external payable {
        vault.depositNative{value: amount}();
    }

    function deposit(address asset, uint256 amount) external {
        vault.deposit(asset, amount);
    }

    function withdraw(address asset, uint256 amount) external {
        vault.withdraw(asset, amount);
    }
}

/// @notice Contract wallet with no `receive` and no `fallback`: BNB sent to it always fails (A28).
/// @dev Its Vault balance is preserved because `withdraw` reverts the whole transaction (SPEC §4.3 V3).
contract NoReceiveReceiver is VaultClient {
    constructor(address vault_) VaultClient(vault_) {}
}

/// @notice Contract wallet whose `receive` reverts, the other half of the rejected-recipient case (A28).
contract RevertingReceiver is VaultClient {
    error ReceiverRejects();

    constructor(address vault_) VaultClient(vault_) {}

    receive() external payable {
        revert ReceiverRejects();
    }
}

/// @notice Contract wallet that re-enters the Vault from inside `receive` during a native withdrawal (A27).
/// @dev One-shot: the armed flag is cleared before the nested call so the mock cannot recurse forever.
contract ReentrantNativeReceiver is VaultClient {
    bytes public payload;
    bool public armed;
    bool public bubble;
    bool public lastCallSucceeded;
    bytes public lastReturnData;
    uint256 public attempts;

    constructor(address vault_) VaultClient(vault_) {}

    /// @notice Arms one nested call into the Vault on the next native transfer received.
    function arm(bytes calldata payload_, bool bubble_) external {
        payload = payload_;
        bubble = bubble_;
        armed = true;
        lastCallSucceeded = false;
        lastReturnData = "";
    }

    receive() external payable {
        if (!armed || payload.length == 0) return;
        armed = false;
        attempts += 1;
        (bool ok, bytes memory data) = address(vault).call(payload);
        lastCallSucceeded = ok;
        lastReturnData = data;
        if (!ok && bubble) {
            assembly ("memory-safe") {
                revert(add(data, 0x20), mload(data))
            }
        }
    }
}
