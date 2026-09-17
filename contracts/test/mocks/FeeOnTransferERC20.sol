// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Taxed (fee-on-transfer) token used to prove the Vault rejects inexact transfers (SPEC §3.1, A28).
/// @dev Labeled mock: never deploy to mainnet. The tax applies to every ordinary transfer, so it exercises
///      both the incoming (`deposit`) and outgoing (`withdraw`) delta checks. Mint and burn are untaxed.
contract FeeOnTransferERC20 is ERC20 {
    /// @notice Where the skimmed tax goes; a plain sink address, not the Vault.
    address public constant TAX_SINK = address(uint160(0xFEE));

    uint8 private immutable _decimals;

    /// @notice Tax in basis points applied to every non-mint, non-burn transfer.
    uint16 public taxBps;

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint16 taxBps_) ERC20(name_, symbol_) {
        _decimals = decimals_;
        taxBps = taxBps_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setTaxBps(uint16 taxBps_) external {
        taxBps = taxBps_;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && taxBps != 0) {
            uint256 tax = (value * taxBps) / 10000;
            if (tax != 0) {
                super._update(from, TAX_SINK, tax);
                value -= tax;
            }
        }
        super._update(from, to, value);
    }
}
