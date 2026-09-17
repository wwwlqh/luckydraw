// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {LuckyVault} from "../../src/LuckyVault.sol";
import {ILuckyVault} from "../../src/interfaces/ILuckyVault.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockDrawCaller} from "../mocks/MockDrawCaller.sol";

/// @notice Shared fixture for the LuckyVault unit suites (SPEC §11.2 "Vault").
/// @dev Abstract: no test cases run from this file directly.
abstract contract LuckyVaultBase is Test {
    LuckyVault internal vault;
    MockDrawCaller internal drawMock;
    MockERC20 internal tkn; // 18 decimals, exact transfer
    MockERC20 internal tkn6; // 6 decimals, exact transfer

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal feeAccount = makeAddr("feeAccount");
    address internal seedSafe = makeAddr("seedSafe");

    address internal constant NATIVE = address(0);
    uint256 internal constant START = 1_700_000_000;
    uint64 internal constant DAY = 86_400;

    function setUp() public virtual {
        vm.warp(START);

        vault = new LuckyVault(owner);
        drawMock = new MockDrawCaller(address(vault));
        tkn = new MockERC20("Token", "TKN", 18);
        tkn6 = new MockERC20("Six", "SIX", 6);

        vm.startPrank(owner);
        vault.setDraw(address(drawMock));
        vault.listAsset(NATIVE, 18);
        vault.setDepositsEnabled(NATIVE, true);
        vault.listAsset(address(tkn), 18);
        vault.setDepositsEnabled(address(tkn), true);
        vault.listAsset(address(tkn6), 6);
        vault.setDepositsEnabled(address(tkn6), true);
        vm.stopPrank();

        address[5] memory funded = [alice, bob, carol, feeAccount, seedSafe];
        for (uint256 i = 0; i < funded.length; i++) {
            vm.deal(funded[i], 1_000 ether);
            tkn.mint(funded[i], 1_000_000 ether);
            tkn6.mint(funded[i], 1_000_000e6);
            vm.startPrank(funded[i]);
            tkn.approve(address(vault), type(uint256).max);
            tkn6.approve(address(vault), type(uint256).max);
            vm.stopPrank();
        }
    }

    // ---- Action helpers ------------------------------------------------------

    function _depositNative(address who, uint256 amount) internal {
        vm.prank(who);
        vault.depositNative{value: amount}();
    }

    function _deposit(address who, address asset, uint256 amount) internal {
        vm.prank(who);
        vault.deposit(asset, amount);
    }

    function _withdraw(address who, address asset, uint256 amount) internal {
        vm.prank(who);
        vault.withdraw(asset, amount);
    }

    function _vaultBalance(address asset) internal view returns (uint256) {
        return asset == NATIVE ? address(vault).balance : IERC20(asset).balanceOf(address(vault));
    }

    function _holderBalance(address who, address asset) internal view returns (uint256) {
        return asset == NATIVE ? who.balance : IERC20(asset).balanceOf(who);
    }

    // ---- Conservation (SPEC §4.3 V1, V2) -------------------------------------

    /// @dev V1: on-chain balance covers the ledger. V2: A equals summed user balances and E equals summed
    ///      registered escrows. `holders` and `roundIds` must enumerate every account/round the test touched.
    function _assertConservation(
        address asset,
        address[] memory holders,
        uint256[] memory roundIds,
        string memory label
    ) internal view {
        uint256 available = vault.totalAvailable(asset);
        uint256 escrowed = vault.totalEscrow(asset);
        assertGe(_vaultBalance(asset), available + escrowed, string.concat(label, ": V1 B >= A+E"));

        uint256 summedBalances;
        for (uint256 i = 0; i < holders.length; i++) {
            summedBalances += vault.balanceOf(holders[i], asset);
        }
        assertEq(summedBalances, available, string.concat(label, ": V2 A == sum(balances)"));

        uint256 summedEscrow;
        for (uint256 i = 0; i < roundIds.length; i++) {
            ILuckyVault.Escrow memory e = vault.getEscrow(roundIds[i]);
            if (e.registered && e.asset == asset) summedEscrow += e.amount;
        }
        assertEq(summedEscrow, escrowed, string.concat(label, ": V2 E == sum(escrows)"));
    }

    function _holders() internal view returns (address[] memory holders) {
        holders = new address[](5);
        holders[0] = alice;
        holders[1] = bob;
        holders[2] = carol;
        holders[3] = feeAccount;
        holders[4] = seedSafe;
    }

    function _ids(uint256 a) internal pure returns (uint256[] memory out) {
        out = new uint256[](1);
        out[0] = a;
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory out) {
        out = new uint256[](2);
        out[0] = a;
        out[1] = b;
    }
}
