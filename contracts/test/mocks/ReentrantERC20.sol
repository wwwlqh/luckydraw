// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Exact-transfer token that re-enters the Vault from inside `transfer`/`transferFrom` (A27).
/// @dev Labeled mock: never deploy to mainnet. The token itself moves the exact amount, so it passes the
///      Vault's delta checks; the attack is purely the nested call. One-shot by construction: the attack
///      flag is cleared before the callback so the mock cannot recurse forever.
contract ReentrantERC20 is ERC20 {
    uint8 private immutable _decimals;

    /// @notice The contract re-entered during a transfer.
    address public target;

    /// @notice ABI-encoded call executed against `target` during a transfer.
    bytes public payload;

    /// @notice Armed state; cleared as soon as the callback fires.
    bool public armed;

    /// @notice When true the mock bubbles the nested revert, failing the whole outer transaction.
    bool public bubble;

    /// @notice Whether the last nested call succeeded. False proves the reentrancy guard fired.
    bool public lastCallSucceeded;

    /// @notice Raw return/revert data of the last nested call.
    bytes public lastReturnData;

    /// @notice Number of nested calls actually attempted.
    uint256 public attempts;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Arms one nested call into `target_` with `payload_` on the next ordinary transfer.
    function arm(address target_, bytes calldata payload_, bool bubble_) external {
        target = target_;
        payload = payload_;
        bubble = bubble_;
        armed = true;
        lastCallSucceeded = false;
        lastReturnData = "";
    }

    /// @notice Disarms the mock so it behaves as an ordinary exact-transfer token.
    function disarm() external {
        armed = false;
    }

    /// @notice Approves `spender` from this contract's own balance, for tests that deposit as the token.
    function approveFrom(address spender, uint256 amount) external {
        _approve(address(this), spender, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (!armed || target == address(0) || payload.length == 0) return;
        if (from == address(0) || to == address(0)) return; // ignore mint/burn

        armed = false;
        attempts += 1;
        (bool ok, bytes memory data) = target.call(payload);
        lastCallSucceeded = ok;
        lastReturnData = data;
        if (!ok && bubble) {
            assembly ("memory-safe") {
                revert(add(data, 0x20), mload(data))
            }
        }
    }
}
