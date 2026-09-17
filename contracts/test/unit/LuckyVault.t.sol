// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {LuckyVaultBase} from "./LuckyVaultBase.t.sol";
import {LuckyVault} from "../../src/LuckyVault.sol";
import {ILuckyVault} from "../../src/interfaces/ILuckyVault.sol";
import {ReleaseReason} from "../../src/Types.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockDrawCaller} from "../mocks/MockDrawCaller.sol";
import {
    AlreadyBound,
    AlreadyListed,
    DepositsDisabled,
    DepositsPaused,
    InsufficientBalance,
    InvalidAmount,
    InvalidAsset,
    InvalidConfig,
    InvalidRecipient,
    Unauthorized,
    WrongState
} from "../../src/Errors.sol";

/// @notice Listing, binding, ownership, deposits and withdrawals (A01, A29, A33, A34, A35; SPEC §4.2, §8.1).
contract LuckyVaultTest is LuckyVaultBase {
    // ---- A01: deposit credits the full amount, no platform fee ---------------

    function test_A01_NativeDepositCreditsFullAmountWithNoFee() public {
        // Independent expected value: 1 BNB = 1_000_000_000_000_000_000 wei, credited in full.
        _depositNative(alice, 1 ether);

        assertEq(vault.balanceOf(alice, NATIVE), 1_000_000_000_000_000_000, "credit is the full deposit");
        assertEq(vault.totalAvailable(NATIVE), 1_000_000_000_000_000_000, "A tracks the credit");
        assertEq(vault.totalEscrow(NATIVE), 0, "deposits never touch escrow");
        assertEq(address(vault).balance, 1_000_000_000_000_000_000, "the Vault holds exactly the deposit");
    }

    function test_A01_TokenDepositCreditsFullAmountWithNoFee() public {
        // 1.000000 of a 6-decimal token is 1_000_000 raw units.
        _deposit(alice, address(tkn6), 1_000_000);

        assertEq(vault.balanceOf(alice, address(tkn6)), 1_000_000, "credit is the full deposit");
        assertEq(vault.totalAvailable(address(tkn6)), 1_000_000, "A tracks the credit");
        assertEq(tkn6.balanceOf(address(vault)), 1_000_000, "Vault received exactly the deposit");
    }

    function test_DepositEmitsDeposited() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit ILuckyVault.Deposited(alice, address(tkn), 5 ether);
        _deposit(alice, address(tkn), 5 ether);
    }

    // ---- Round trips with exact deltas ---------------------------------------

    function test_NativeRoundTripMovesExactAmounts() public {
        uint256 aliceStart = alice.balance;

        _depositNative(alice, 3 ether);
        assertEq(alice.balance, aliceStart - 3_000_000_000_000_000_000, "wallet debited by exactly 3 BNB");
        assertEq(address(vault).balance, 3_000_000_000_000_000_000, "Vault credited by exactly 3 BNB");

        _withdraw(alice, NATIVE, 1_200_000_000_000_000_000);

        assertEq(vault.balanceOf(alice, NATIVE), 1_800_000_000_000_000_000, "3.0 - 1.2 = 1.8");
        assertEq(vault.totalAvailable(NATIVE), 1_800_000_000_000_000_000, "A follows the debit");
        assertEq(address(vault).balance, 1_800_000_000_000_000_000, "Vault holds only the remainder");
        assertEq(alice.balance, aliceStart - 1_800_000_000_000_000_000, "wallet is net down exactly 1.8 BNB");
    }

    function test_Erc20RoundTripMovesExactAmounts() public {
        uint256 aliceStart = tkn.balanceOf(alice);

        _deposit(alice, address(tkn), 250 ether);
        assertEq(tkn.balanceOf(alice), aliceStart - 250_000_000_000_000_000_000, "wallet debited exactly");

        _withdraw(alice, address(tkn), 99 ether);

        assertEq(vault.balanceOf(alice, address(tkn)), 151_000_000_000_000_000_000, "250 - 99 = 151");
        assertEq(tkn.balanceOf(address(vault)), 151_000_000_000_000_000_000, "Vault holds exactly 151");
        assertEq(tkn.balanceOf(alice), aliceStart - 151_000_000_000_000_000_000, "wallet net down exactly 151");
    }

    function test_WithdrawEmitsWithdrawn() public {
        _deposit(alice, address(tkn), 5 ether);
        vm.expectEmit(true, true, false, true, address(vault));
        emit ILuckyVault.Withdrawn(alice, address(tkn), 2 ether);
        _withdraw(alice, address(tkn), 2 ether);
    }

    function test_WithdrawRecipientIsAlwaysTheCaller() public {
        _deposit(alice, address(tkn), 10 ether);
        uint256 bobBefore = tkn.balanceOf(bob);

        _withdraw(alice, address(tkn), 10 ether);

        assertEq(tkn.balanceOf(bob), bobBefore, "no other account can be routed to");
        assertEq(vault.balanceOf(bob, address(tkn)), 0, "bob has no ledger entry either");
    }

    // ---- Deposit guards -------------------------------------------------------

    function test_A34_DepositRevertsUntilDrawIsBound() public {
        LuckyVault fresh = new LuckyVault(owner);
        vm.startPrank(owner);
        fresh.listAsset(NATIVE, 18);
        fresh.setDepositsEnabled(NATIVE, true);
        fresh.listAsset(address(tkn), 18);
        fresh.setDepositsEnabled(address(tkn), true);
        vm.stopPrank();

        assertEq(fresh.draw(), address(0), "unbound");

        vm.prank(alice);
        vm.expectRevert(WrongState.selector);
        fresh.depositNative{value: 1 ether}();

        vm.startPrank(alice);
        tkn.approve(address(fresh), type(uint256).max);
        vm.expectRevert(WrongState.selector);
        fresh.deposit(address(tkn), 1 ether);
        vm.stopPrank();

        // Binding unblocks deposits without changing any other rule.
        MockDrawCaller boundDraw = new MockDrawCaller(address(fresh));
        vm.prank(owner);
        fresh.setDraw(address(boundDraw));
        assertEq(fresh.draw(), address(boundDraw), "Draw bound");
        assertEq(address(boundDraw.vault()), address(fresh), "the mock Draw points back at this Vault");

        vm.prank(alice);
        fresh.depositNative{value: 1 ether}();
        assertEq(fresh.balanceOf(alice, NATIVE), 1_000_000_000_000_000_000, "deposit works once bound");
    }

    function test_DepositRevertsForUnlistedAsset() public {
        MockERC20 stranger = new MockERC20("Stranger", "STR", 18);
        stranger.mint(alice, 10 ether);

        vm.startPrank(alice);
        stranger.approve(address(vault), type(uint256).max);
        vm.expectRevert(InvalidAsset.selector);
        vault.deposit(address(stranger), 1 ether);
        vm.stopPrank();
    }

    function test_DepositRevertsWhenAssetDisabled() public {
        vm.prank(owner);
        vault.setDepositsEnabled(address(tkn), false);

        vm.prank(alice);
        vm.expectRevert(DepositsDisabled.selector);
        vault.deposit(address(tkn), 1 ether);

        vm.prank(owner);
        vault.setDepositsEnabled(NATIVE, false);
        vm.prank(alice);
        vm.expectRevert(DepositsDisabled.selector);
        vault.depositNative{value: 1 ether}();
    }

    function test_DepositRevertsWhenGloballyPaused() public {
        vm.prank(owner);
        vault.setDepositsPaused(true);

        vm.prank(alice);
        vm.expectRevert(DepositsPaused.selector);
        vault.deposit(address(tkn), 1 ether);

        vm.prank(alice);
        vm.expectRevert(DepositsPaused.selector);
        vault.depositNative{value: 1 ether}();
    }

    function test_NativeSentinelIsRejectedInTheErc20DepositPath() public {
        vm.prank(alice);
        vm.expectRevert(InvalidAsset.selector);
        vault.deposit(NATIVE, 1 ether);
    }

    function test_ZeroAmountDepositsAndWithdrawalsRevert() public {
        vm.prank(alice);
        vm.expectRevert(InvalidAmount.selector);
        vault.depositNative{value: 0}();

        vm.prank(alice);
        vm.expectRevert(InvalidAmount.selector);
        vault.deposit(address(tkn), 0);

        vm.prank(alice);
        vm.expectRevert(InvalidAmount.selector);
        vault.withdraw(address(tkn), 0);
    }

    function test_WithdrawRevertsOnInsufficientBalanceAndUnlistedAsset() public {
        _deposit(alice, address(tkn), 1 ether);

        vm.prank(alice);
        vm.expectRevert(InsufficientBalance.selector);
        vault.withdraw(address(tkn), 1 ether + 1);

        vm.prank(bob);
        vm.expectRevert(InsufficientBalance.selector);
        vault.withdraw(address(tkn), 1);

        MockERC20 stranger = new MockERC20("Stranger", "STR", 18);
        vm.prank(alice);
        vm.expectRevert(InvalidAsset.selector);
        vault.withdraw(address(stranger), 1);
    }

    // ---- V3: withdrawal is never gated by a pause ----------------------------

    function test_V3_WithdrawIsNeverGatedByPauseOrDisable() public {
        _depositNative(alice, 4 ether);
        _deposit(alice, address(tkn), 4 ether);

        vm.startPrank(owner);
        vault.setDepositsPaused(true);
        vault.setDepositsEnabled(NATIVE, false);
        vault.setDepositsEnabled(address(tkn), false);
        vm.stopPrank();

        _withdraw(alice, NATIVE, 4 ether);
        _withdraw(alice, address(tkn), 4 ether);

        assertEq(vault.balanceOf(alice, NATIVE), 0, "native fully withdrawn while paused");
        assertEq(vault.balanceOf(alice, address(tkn)), 0, "token fully withdrawn while paused");
        assertEq(address(vault).balance, 0, "no native dust retained");
        assertEq(tkn.balanceOf(address(vault)), 0, "no token dust retained");
    }

    // ---- A33: listAsset admission --------------------------------------------

    function test_A33_DuplicateListingReverts() public {
        vm.prank(owner);
        vm.expectRevert(AlreadyListed.selector);
        vault.listAsset(address(tkn), 18);
    }

    function test_A33_DecimalsMismatchReverts() public {
        MockERC20 eight = new MockERC20("Eight", "EI8", 8);
        vm.prank(owner);
        vm.expectRevert(InvalidConfig.selector);
        vault.listAsset(address(eight), 6);
    }

    function test_A33_NonzeroAddressDeclaredAsBnbReverts() public {
        // A nonzero address with no code is not an admissible ERC-20, whatever decimals are claimed.
        vm.prank(owner);
        vm.expectRevert(InvalidAsset.selector);
        vault.listAsset(makeAddr("notAToken"), 18);
    }

    function test_A33_NativeMustDeclareEighteenDecimals() public {
        LuckyVault fresh = new LuckyVault(owner);
        vm.prank(owner);
        vm.expectRevert(InvalidConfig.selector);
        fresh.listAsset(NATIVE, 8);

        vm.prank(owner);
        fresh.listAsset(NATIVE, 18);
        assertEq(fresh.getAsset(NATIVE).tokenDecimals, 18, "native is 18 decimals");
    }

    function test_A33_DecimalsAboveEighteenRejected() public {
        MockERC20 twenty = new MockERC20("Twenty", "T20", 20);
        vm.prank(owner);
        vm.expectRevert(InvalidConfig.selector);
        vault.listAsset(address(twenty), 20);
    }

    function test_A33_VaultAndDrawAddressesRejected() public {
        vm.prank(owner);
        vm.expectRevert(InvalidAsset.selector);
        vault.listAsset(address(vault), 18);

        vm.prank(owner);
        vm.expectRevert(InvalidAsset.selector);
        vault.listAsset(address(drawMock), 18);
    }

    function test_A33_NewAssetStartsDepositDisabled() public {
        MockERC20 fresh18 = new MockERC20("Fresh", "FRSH", 18);

        vm.expectEmit(true, false, false, true, address(vault));
        emit ILuckyVault.AssetListed(address(fresh18), 18);
        vm.prank(owner);
        vault.listAsset(address(fresh18), 18);

        ILuckyVault.AssetRecord memory rec = vault.getAsset(address(fresh18));
        assertTrue(rec.listed, "listed");
        assertEq(rec.tokenDecimals, 18, "decimals recorded");
        assertFalse(rec.depositsEnabled, "starts deposit-disabled");

        fresh18.mint(alice, 1 ether);
        vm.startPrank(alice);
        fresh18.approve(address(vault), type(uint256).max);
        vm.expectRevert(DepositsDisabled.selector);
        vault.deposit(address(fresh18), 1 ether);
        vm.stopPrank();
    }

    function test_ListAssetAcceptsZeroDecimalToken() public {
        MockERC20 zeroDec = new MockERC20("Zero", "ZER", 0);
        vm.prank(owner);
        vault.listAsset(address(zeroDec), 0);
        assertEq(vault.getAsset(address(zeroDec)).tokenDecimals, 0, "0 decimals is admissible");
    }

    // ---- A34: setDraw is one-time --------------------------------------------

    function test_A34_SecondSetDrawReverts() public {
        MockDrawCaller other = new MockDrawCaller(address(vault));
        vm.prank(owner);
        vm.expectRevert(AlreadyBound.selector);
        vault.setDraw(address(other));
        assertEq(vault.draw(), address(drawMock), "binding is permanent");
    }

    function test_SetDrawValidatesTheCandidate() public {
        LuckyVault fresh = new LuckyVault(owner);

        vm.prank(owner);
        vm.expectRevert(InvalidConfig.selector);
        fresh.setDraw(address(0));

        vm.prank(owner);
        vm.expectRevert(InvalidConfig.selector);
        fresh.setDraw(makeAddr("codeless"));

        vm.prank(owner);
        vm.expectRevert(InvalidConfig.selector);
        fresh.setDraw(address(fresh));

        // A listed asset can never become the Draw.
        vm.prank(owner);
        fresh.listAsset(address(tkn), 18);
        vm.prank(owner);
        vm.expectRevert(InvalidConfig.selector);
        fresh.setDraw(address(tkn));

        MockDrawCaller good = new MockDrawCaller(address(fresh));
        vm.expectEmit(true, false, false, true, address(fresh));
        emit ILuckyVault.DrawBound(address(good), owner);
        vm.prank(owner);
        fresh.setDraw(address(good));
        assertEq(fresh.draw(), address(good), "bound");
    }

    // ---- A35: two-step ownership, no renounce path ---------------------------

    function test_A35_TransferOwnershipToZeroReverts() public {
        vm.prank(owner);
        vm.expectRevert(InvalidRecipient.selector);
        vault.transferOwnership(address(0));
        assertEq(vault.owner(), owner, "owner unchanged");
        assertEq(vault.pendingOwner(), address(0), "no pending owner created");
    }

    function test_A35_AcceptOwnershipByNonPendingAddressReverts() public {
        vm.prank(owner);
        vault.transferOwnership(bob);
        assertEq(vault.pendingOwner(), bob, "pending owner recorded");
        assertEq(vault.owner(), owner, "owner not yet changed");

        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        vault.acceptOwnership();

        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob, "two-step transfer completed");
        assertEq(vault.pendingOwner(), address(0), "pending cleared");
    }

    function test_A35_NoRenouncePathExists() public {
        vm.prank(owner);
        vm.expectRevert(InvalidRecipient.selector);
        vault.renounceOwnership();
        assertEq(vault.owner(), owner, "still owned");
    }

    function test_OwnerOnlyMethodsRejectStrangersAndTheDraw() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vault.setDepositsPaused(true);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(drawMock)));
        drawMock.trySetDepositsPaused(true);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(drawMock)));
        drawMock.tryListAsset(makeAddr("x"), 18);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(drawMock)));
        drawMock.trySetDepositsEnabled(address(tkn), false);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(drawMock)));
        drawMock.trySetDraw(address(drawMock));
    }

    function test_DrawOnlyMethodsRejectEveryoneElse() public {
        vm.prank(alice);
        vm.expectRevert(Unauthorized.selector);
        vault.registerRound(1, address(tkn), uint64(block.timestamp + DAY));

        vm.prank(owner);
        vm.expectRevert(Unauthorized.selector);
        vault.lock(1, alice, 1);

        vm.prank(owner);
        vm.expectRevert(Unauthorized.selector);
        vault.lockSeed(1, seedSafe, 1);

        vm.prank(owner);
        vm.expectRevert(Unauthorized.selector);
        vault.closeEscrow(1);

        vm.prank(owner);
        vm.expectRevert(Unauthorized.selector);
        vault.release(1, alice, 1, ReleaseReason.Prize);
    }

    // ---- Configuration events carry actor, old and new ------------------------

    function test_ConfigurationEventsCarryActorOldAndNew() public {
        vm.expectEmit(true, false, false, true, address(vault));
        emit ILuckyVault.DepositsEnabledSet(address(tkn), owner, true, false);
        vm.prank(owner);
        vault.setDepositsEnabled(address(tkn), false);

        vm.expectEmit(false, false, false, true, address(vault));
        emit ILuckyVault.DepositsPausedSet(owner, false, true);
        vm.prank(owner);
        vault.setDepositsPaused(true);
        assertTrue(vault.depositsPaused(), "state follows the event");

        vm.expectEmit(true, false, false, true, address(vault));
        emit ILuckyVault.SeedAuthorized(seedSafe, address(tkn), 0, 7 ether);
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 7 ether);
        assertEq(vault.seedMaxPerRound(seedSafe, address(tkn)), 7 ether, "cap recorded");

        vm.expectEmit(true, false, false, true, address(vault));
        emit ILuckyVault.SeedAuthorized(seedSafe, address(tkn), 7 ether, 0);
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 0);
        assertEq(vault.seedMaxPerRound(seedSafe, address(tkn)), 0, "revoked");
    }

    function test_SetDepositsEnabledRequiresAListedAsset() public {
        vm.prank(owner);
        vm.expectRevert(InvalidAsset.selector);
        vault.setDepositsEnabled(makeAddr("unlisted"), true);
    }

    // ---- A29: donations and forced BNB create surplus only -------------------

    function test_A29_ForcedNativeAndTokenDonationsCreateSurplusWithoutCredit() public {
        _depositNative(alice, 2 ether);
        _deposit(alice, address(tkn), 2 ether);

        uint256 availableNativeBefore = vault.totalAvailable(NATIVE);
        uint256 availableTokenBefore = vault.totalAvailable(address(tkn));

        // Forced BNB (selfdestruct-style arrival): the balance rises, the ledger does not.
        vm.deal(address(vault), address(vault).balance + 5 ether);
        // Direct token donation.
        vm.prank(bob);
        tkn.transfer(address(vault), 9 ether);

        assertEq(vault.totalAvailable(NATIVE), availableNativeBefore, "no native credit fabricated");
        assertEq(vault.totalAvailable(address(tkn)), availableTokenBefore, "no token credit fabricated");
        assertEq(vault.balanceOf(bob, address(tkn)), 0, "the donor gets nothing");
        assertEq(vault.balanceOf(alice, NATIVE), 2 ether, "existing balances untouched");

        // V1 holds with a strict surplus and there is no sweep to recover it.
        assertEq(address(vault).balance, 7 ether, "2 deposited + 5 forced");
        assertEq(tkn.balanceOf(address(vault)), 11 ether, "2 deposited + 9 donated");
        assertGt(address(vault).balance, vault.totalAvailable(NATIVE) + vault.totalEscrow(NATIVE), "native surplus");
        assertGt(
            tkn.balanceOf(address(vault)),
            vault.totalAvailable(address(tkn)) + vault.totalEscrow(address(tkn)),
            "token surplus"
        );

        // Alice can still withdraw exactly her ledger entry, and no more.
        _withdraw(alice, NATIVE, 2 ether);
        vm.prank(alice);
        vm.expectRevert(InsufficientBalance.selector);
        vault.withdraw(NATIVE, 1);
        assertEq(address(vault).balance, 5 ether, "the surplus stays stranded");
    }

    function test_A29_PlainNativeSendReverts() public {
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertFalse(ok, "no receive() and no fallback()");
        assertEq(address(vault).balance, 0, "nothing arrived");

        // A call with data to an unknown selector also reverts: there is no fallback.
        vm.prank(alice);
        (bool ok2,) = address(vault).call{value: 1 ether}(abi.encodeWithSignature("nope()"));
        assertFalse(ok2, "unknown selector reverts");
        assertEq(address(vault).balance, 0, "still nothing arrived");
    }
}
