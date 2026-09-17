// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {LuckyVaultBase} from "./LuckyVaultBase.t.sol";
import {ILuckyVault} from "../../src/interfaces/ILuckyVault.sol";
import {ReleaseReason} from "../../src/Types.sol";
import {FeeOnTransferERC20} from "../mocks/FeeOnTransferERC20.sol";
import {ReentrantERC20} from "../mocks/ReentrantERC20.sol";
import {NoReceiveReceiver, ReentrantNativeReceiver, RevertingReceiver} from "../mocks/RejectingReceiver.sol";
import {TransferFailed, TransferMismatch} from "../../src/Errors.sol";

/// @notice Adversarial suite: reentrancy, taxed tokens, rejecting recipients, outbound-path enumeration and
///         gas budgets (A27, A28, A39; SPEC §4.3 V1-V4, §11.2, §11.3).
contract LuckyVaultSecurityTest is LuckyVaultBase {
    uint256 internal constant ROUND = 1;
    uint256 internal constant ROUND_2 = 2;
    uint64 internal closesAt;

    FeeOnTransferERC20 internal taxed;
    ReentrantERC20 internal evil;

    function setUp() public override {
        super.setUp();
        closesAt = uint64(START + DAY);

        // Listed while untaxed, exactly as a review would admit it; the tax is switched on later.
        taxed = new FeeOnTransferERC20("Taxed", "TAX", 18, 0);
        evil = new ReentrantERC20("Evil", "EVIL", 18);

        vm.startPrank(owner);
        vault.listAsset(address(taxed), 18);
        vault.setDepositsEnabled(address(taxed), true);
        vault.listAsset(address(evil), 18);
        vault.setDepositsEnabled(address(evil), true);
        vm.stopPrank();

        taxed.mint(alice, 1_000 ether);
        evil.mint(alice, 1_000 ether);
        vm.startPrank(alice);
        taxed.approve(address(vault), type(uint256).max);
        evil.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    // ---- A28: fee-on-transfer in and out -------------------------------------

    function test_A28_TaxedDepositRevertsAndLeavesBalancesUnchanged() public {
        taxed.setTaxBps(500); // 5%

        uint256 aliceWalletBefore = taxed.balanceOf(alice);
        uint256 vaultBefore = taxed.balanceOf(address(vault));

        vm.prank(alice);
        vm.expectRevert(TransferMismatch.selector);
        vault.deposit(address(taxed), 100 ether);

        assertEq(taxed.balanceOf(alice), aliceWalletBefore, "the taxed transfer was rolled back");
        assertEq(taxed.balanceOf(address(vault)), vaultBefore, "the Vault kept nothing");
        assertEq(taxed.balanceOf(taxed.TAX_SINK()), 0, "no tax was ever skimmed");
        assertEq(vault.balanceOf(alice, address(taxed)), 0, "no credit");
        assertEq(vault.totalAvailable(address(taxed)), 0, "A unchanged");
    }

    function test_A28_TaxedWithdrawRevertsAndLeavesBalancesUnchanged() public {
        // Deposit while exact, then the issuer turns the tax on (the "later malicious upgrade" of §3.1).
        _deposit(alice, address(taxed), 100 ether);
        assertEq(vault.balanceOf(alice, address(taxed)), 100 ether, "credited while exact");

        taxed.setTaxBps(500);

        uint256 aliceWalletBefore = taxed.balanceOf(alice);
        uint256 vaultBefore = taxed.balanceOf(address(vault));

        vm.prank(alice);
        vm.expectRevert(TransferMismatch.selector);
        vault.withdraw(address(taxed), 40 ether);

        assertEq(vault.balanceOf(alice, address(taxed)), 100 ether, "ledger untouched by the failed exit");
        assertEq(vault.totalAvailable(address(taxed)), 100 ether, "A untouched");
        assertEq(taxed.balanceOf(alice), aliceWalletBefore, "wallet untouched");
        assertEq(taxed.balanceOf(address(vault)), vaultBefore, "Vault holdings untouched");

        // Turning the tax back off restores an ordinary exit.
        taxed.setTaxBps(0);
        _withdraw(alice, address(taxed), 40 ether);
        assertEq(vault.balanceOf(alice, address(taxed)), 60 ether, "100 - 40");
    }

    // ---- A28: native recipient rejects ---------------------------------------

    function test_A28_NativeRecipientWithNoReceiveKeepsItsBalance() public {
        NoReceiveReceiver wallet = new NoReceiveReceiver(address(vault));
        vm.deal(address(wallet), 5 ether);
        wallet.depositNative{value: 5 ether}(5 ether);

        assertEq(vault.balanceOf(address(wallet), NATIVE), 5 ether, "deposit succeeded");

        vm.expectRevert(TransferFailed.selector);
        wallet.withdraw(NATIVE, 5 ether);

        assertEq(vault.balanceOf(address(wallet), NATIVE), 5 ether, "balance preserved (SPEC 4.1)");
        assertEq(vault.totalAvailable(NATIVE), 5 ether, "A preserved");
        assertEq(address(vault).balance, 5 ether, "the BNB stayed in the Vault");
    }

    function test_A28_NativeRecipientThatRevertsKeepsItsBalance() public {
        RevertingReceiver wallet = new RevertingReceiver(address(vault));
        vm.deal(address(wallet), 5 ether);
        wallet.depositNative{value: 5 ether}(5 ether);

        vm.expectRevert(TransferFailed.selector);
        wallet.withdraw(NATIVE, 1 ether);

        assertEq(vault.balanceOf(address(wallet), NATIVE), 5 ether, "balance preserved");
        assertEq(address(vault).balance, 5 ether, "no partial send");

        // Its ERC-20 balance is unaffected by the native rejection.
        _deposit(alice, address(tkn), 10 ether);
        vm.prank(alice);
        vault.withdraw(address(tkn), 10 ether);
        assertEq(tkn.balanceOf(alice), 1_000_000 ether, "token exits are independent");
    }

    // ---- A27: reentrancy into every mutation ---------------------------------

    /// @dev Every state-changing entry point of the Vault, encoded for a nested call.
    function _mutationPayloads() internal returns (bytes[] memory payloads, string[] memory names) {
        payloads = new bytes[](13);
        names = new string[](13);
        payloads[0] = abi.encodeCall(ILuckyVault.depositNative, ());
        names[0] = "depositNative";
        payloads[1] = abi.encodeCall(ILuckyVault.deposit, (address(tkn), 1 ether));
        names[1] = "deposit";
        payloads[2] = abi.encodeCall(ILuckyVault.withdraw, (address(tkn), 1 ether));
        names[2] = "withdraw";
        payloads[3] = abi.encodeCall(ILuckyVault.authorizeSeed, (address(tkn), 1 ether));
        names[3] = "authorizeSeed";
        payloads[4] = abi.encodeCall(ILuckyVault.listAsset, (makeAddr("newAsset"), 18));
        names[4] = "listAsset";
        payloads[5] = abi.encodeCall(ILuckyVault.setDepositsEnabled, (address(tkn), false));
        names[5] = "setDepositsEnabled";
        payloads[6] = abi.encodeCall(ILuckyVault.setDepositsPaused, (true));
        names[6] = "setDepositsPaused";
        payloads[7] = abi.encodeCall(ILuckyVault.setDraw, (address(drawMock)));
        names[7] = "setDraw";
        payloads[8] = abi.encodeCall(ILuckyVault.registerRound, (ROUND_2, address(tkn), closesAt));
        names[8] = "registerRound";
        payloads[9] = abi.encodeCall(ILuckyVault.lock, (ROUND, alice, 1 ether));
        names[9] = "lock";
        payloads[10] = abi.encodeCall(ILuckyVault.lockSeed, (ROUND, seedSafe, 1 ether));
        names[10] = "lockSeed";
        payloads[11] = abi.encodeCall(ILuckyVault.closeEscrow, (ROUND));
        names[11] = "closeEscrow";
        payloads[12] = abi.encodeCall(ILuckyVault.release, (ROUND, alice, 1 ether, ReleaseReason.Prize));
        names[12] = "release";
    }

    function test_A27_TokenReentryIntoEveryMutationIsRefused() public {
        _deposit(alice, address(tkn), 100 ether);
        drawMock.registerRound(ROUND, address(tkn), closesAt);
        drawMock.lock(ROUND, alice, 10 ether);

        (bytes[] memory payloads, string[] memory names) = _mutationPayloads();

        uint256 expectedCredit;
        for (uint256 i = 0; i < payloads.length; i++) {
            evil.arm(address(vault), payloads[i], false);

            uint256 escrowBefore = vault.getEscrow(ROUND).amount;
            _deposit(alice, address(evil), 1 ether);
            expectedCredit += 1 ether;

            assertEq(evil.attempts(), i + 1, string.concat(names[i], ": the nested call was attempted"));
            assertFalse(evil.lastCallSucceeded(), string.concat(names[i], ": nested mutation blocked"));
            assertEq(
                _selectorOf(evil.lastReturnData()),
                ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
                string.concat(names[i], ": refused by the guard, not by a later branch")
            );

            // The outer deposit is the only ledger change; the nested call left nothing behind.
            assertEq(vault.balanceOf(alice, address(evil)), expectedCredit, "only the honest deposit credited");
            assertEq(vault.totalAvailable(address(evil)), expectedCredit, "A matches");
            assertEq(vault.balanceOf(alice, address(tkn)), 90 ether, "the other asset is untouched");
            assertEq(vault.getEscrow(ROUND).amount, escrowBefore, "escrow untouched");
            assertEq(vault.totalEscrow(address(evil)), 0, "no escrow fabricated");
            assertFalse(vault.depositsPaused(), "no configuration slipped through");
            assertEq(vault.seedMaxPerRound(address(evil), address(tkn)), 0, "no seed authorization slipped through");
        }

        _assertConservation(address(evil), _holders(), _ids(ROUND, ROUND_2), "after token reentry sweep");
        _assertConservation(address(tkn), _holders(), _ids(ROUND, ROUND_2), "after token reentry sweep");
    }

    function test_A27_BubbledTokenReentryRevertsTheWholeDeposit() public {
        _deposit(alice, address(evil), 10 ether);
        uint256 walletBefore = evil.balanceOf(alice);

        evil.arm(address(vault), abi.encodeCall(ILuckyVault.withdraw, (address(evil), 10 ether)), true);

        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vault.deposit(address(evil), 1 ether);

        assertEq(vault.balanceOf(alice, address(evil)), 10 ether, "no partial ledger change");
        assertEq(vault.totalAvailable(address(evil)), 10 ether, "A unchanged");
        assertEq(evil.balanceOf(alice), walletBefore, "no partial token movement");
        assertEq(evil.balanceOf(address(vault)), 10 ether, "Vault holdings unchanged");
    }

    function test_A27_TokenReentryDuringWithdrawIsRefused() public {
        _deposit(alice, address(evil), 10 ether);

        // Re-entering withdraw during the outgoing transfer is the classic double-spend attempt.
        evil.arm(address(vault), abi.encodeCall(ILuckyVault.withdraw, (address(evil), 10 ether)), false);

        _withdraw(alice, address(evil), 10 ether);

        assertEq(evil.attempts(), 1, "the nested withdraw was attempted");
        assertFalse(evil.lastCallSucceeded(), "and refused");
        assertEq(
            _selectorOf(evil.lastReturnData()),
            ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
            "refused by the guard"
        );
        assertEq(vault.balanceOf(alice, address(evil)), 0, "debited exactly once");
        assertEq(vault.totalAvailable(address(evil)), 0, "A debited exactly once");
        assertEq(evil.balanceOf(address(vault)), 0, "the Vault paid out exactly once");
        assertEq(evil.balanceOf(alice), 1_000 ether, "alice is whole, not doubled");
    }

    function test_A27_NativeReceiverReentryIntoEveryMutationIsRefused() public {
        ReentrantNativeReceiver wallet = new ReentrantNativeReceiver(address(vault));
        vm.deal(address(wallet), 100 ether);
        wallet.depositNative{value: 100 ether}(100 ether);

        _deposit(alice, address(tkn), 100 ether);
        drawMock.registerRound(ROUND, address(tkn), closesAt);
        drawMock.lock(ROUND, alice, 10 ether);

        (bytes[] memory payloads, string[] memory names) = _mutationPayloads();

        uint256 expectedBalance = 100 ether;
        for (uint256 i = 0; i < payloads.length; i++) {
            wallet.arm(payloads[i], false);
            wallet.withdraw(NATIVE, 1 ether);
            expectedBalance -= 1 ether;

            assertEq(wallet.attempts(), i + 1, string.concat(names[i], ": nested call attempted"));
            assertFalse(wallet.lastCallSucceeded(), string.concat(names[i], ": nested mutation blocked"));
            assertEq(
                _selectorOf(wallet.lastReturnData()),
                ReentrancyGuard.ReentrancyGuardReentrantCall.selector,
                string.concat(names[i], ": refused by the guard")
            );
            assertEq(vault.balanceOf(address(wallet), NATIVE), expectedBalance, "debited exactly once per call");
            assertEq(vault.totalAvailable(NATIVE), expectedBalance, "A matches");
            assertEq(address(vault).balance, expectedBalance, "custody matches the ledger");
            assertEq(vault.getEscrow(ROUND).amount, 10 ether, "escrow untouched");
        }

        _assertConservation(NATIVE, _nativeHolders(address(wallet)), _ids(ROUND, ROUND_2), "native reentry sweep");
    }

    function test_A27_BubbledNativeReentryRevertsTheWholeWithdrawal() public {
        ReentrantNativeReceiver wallet = new ReentrantNativeReceiver(address(vault));
        vm.deal(address(wallet), 10 ether);
        wallet.depositNative{value: 10 ether}(10 ether);
        uint256 walletHeldBefore = address(wallet).balance;

        wallet.arm(abi.encodeCall(ILuckyVault.withdraw, (NATIVE, 10 ether)), true);

        // The guard refuses the nested call, the receiver bubbles that, and the Vault's low-level send
        // therefore fails: `withdraw` surfaces TransferFailed and the whole transaction rolls back.
        vm.expectRevert(TransferFailed.selector);
        wallet.withdraw(NATIVE, 1 ether);

        assertEq(vault.balanceOf(address(wallet), NATIVE), 10 ether, "no partial ledger change");
        assertEq(vault.totalAvailable(NATIVE), 10 ether, "A unchanged");
        assertEq(address(vault).balance, 10 ether, "no BNB left the Vault");
        assertEq(address(wallet).balance, walletHeldBefore, "and none arrived at the receiver");
    }

    // ---- A39 / V4: withdraw is the only outbound path ------------------------

    function test_A39_OnlyWithdrawMovesAssetsOut() public {
        _deposit(alice, address(tkn), 100 ether);
        _depositNative(alice, 100 ether);
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 50 ether);

        uint256 tokenHeld = tkn.balanceOf(address(vault));
        uint256 nativeHeld = address(vault).balance;
        assertEq(tokenHeld, 150 ether, "deposits are the only inflow so far");
        assertEq(nativeHeld, 100 ether, "native inflow");

        // A scripted sequence of every non-withdraw mutation the Vault exposes.
        drawMock.registerRound(ROUND, address(tkn), closesAt);
        _assertCustodyUnchanged(tokenHeld, nativeHeld, "registerRound");

        drawMock.lock(ROUND, alice, 40 ether);
        _assertCustodyUnchanged(tokenHeld, nativeHeld, "lock");

        drawMock.lockSeed(ROUND, seedSafe, 5 ether);
        _assertCustodyUnchanged(tokenHeld, nativeHeld, "lockSeed");

        drawMock.closeEscrow(ROUND);
        _assertCustodyUnchanged(tokenHeld, nativeHeld, "closeEscrow");

        drawMock.release(ROUND, bob, 43_650_000_000_000_000_000, ReleaseReason.Prize);
        _assertCustodyUnchanged(tokenHeld, nativeHeld, "release Prize");

        drawMock.release(ROUND, feeAccount, 1_350_000_000_000_000_000, ReleaseReason.Fee);
        _assertCustodyUnchanged(tokenHeld, nativeHeld, "release Fee");

        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 0);
        _assertCustodyUnchanged(tokenHeld, nativeHeld, "authorizeSeed");

        vm.startPrank(owner);
        vault.setDepositsPaused(true);
        vault.setDepositsEnabled(address(tkn), false);
        vault.listAsset(address(new FeeOnTransferERC20("Other", "OTH", 18, 0)), 18);
        vault.transferOwnership(bob);
        vm.stopPrank();
        vm.prank(bob);
        vault.acceptOwnership();
        _assertCustodyUnchanged(tokenHeld, nativeHeld, "owner surface");

        // Selectors a sweep/upgrade/rescue backdoor would use simply do not exist: no fallback catches them.
        string[5] memory backdoors =
            ["sweep(address,uint256)", "rescue(address)", "execute(address,bytes)", "upgradeTo(address)", "call()"];
        for (uint256 i = 0; i < backdoors.length; i++) {
            (bool ok,) = address(vault).call(abi.encodeWithSignature(backdoors[i]));
            assertFalse(ok, "no backdoor selector is implemented");
        }
        _assertCustodyUnchanged(tokenHeld, nativeHeld, "backdoor probes");

        // Only withdraw changes custody, and only by the caller's own credited amount.
        vm.prank(bob);
        vault.withdraw(address(tkn), 43_650_000_000_000_000_000);
        assertEq(tkn.balanceOf(address(vault)), tokenHeld - 43_650_000_000_000_000_000, "withdraw is the one exit");
        assertEq(address(vault).balance, nativeHeld, "native custody still untouched");
    }

    function _assertCustodyUnchanged(uint256 tokenHeld, uint256 nativeHeld, string memory step) internal view {
        assertEq(tkn.balanceOf(address(vault)), tokenHeld, string.concat(step, ": no token left the Vault"));
        assertEq(address(vault).balance, nativeHeld, string.concat(step, ": no BNB left the Vault"));
    }

    // ---- Gas (SPEC §11.2) ----------------------------------------------------

    function test_Gas_MoneyPaths() public {
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn), 5 ether);
        _deposit(seedSafe, address(tkn), 50 ether);
        _deposit(alice, address(tkn), 100 ether); // warm the asset slots first
        _depositNative(alice, 100 ether);
        drawMock.registerRound(ROUND, address(tkn), closesAt);

        uint256 g;

        vm.prank(alice);
        g = gasleft();
        vault.deposit(address(tkn), 10 ether);
        g -= gasleft();
        console2.log("gas deposit(ERC20)      ", g);

        vm.prank(bob);
        g = gasleft();
        vault.depositNative{value: 10 ether}();
        g -= gasleft();
        console2.log("gas depositNative       ", g);

        vm.prank(address(drawMock));
        g = gasleft();
        vault.lock(ROUND, alice, 10 ether);
        g -= gasleft();
        console2.log("gas lock                ", g);

        vm.prank(address(drawMock));
        g = gasleft();
        vault.lockSeed(ROUND, seedSafe, 5 ether);
        g -= gasleft();
        console2.log("gas lockSeed            ", g);

        vm.prank(address(drawMock));
        g = gasleft();
        vault.release(ROUND, alice, 4 ether, ReleaseReason.Prize);
        g -= gasleft();
        console2.log("gas release             ", g);

        vm.prank(alice);
        g = gasleft();
        vault.withdraw(address(tkn), 10 ether);
        g -= gasleft();
        console2.log("gas withdraw(ERC20)     ", g);
        assertLt(g, 120_000, "withdraw must fit the SPEC 11.2 budget of 120,000");

        vm.prank(alice);
        g = gasleft();
        vault.withdraw(NATIVE, 10 ether);
        g -= gasleft();
        console2.log("gas withdraw(native)    ", g);
        assertLt(g, 120_000, "withdraw must fit the SPEC 11.2 budget of 120,000");
    }

    // ---- Helpers --------------------------------------------------------------

    function _selectorOf(bytes memory data) internal pure returns (bytes4) {
        if (data.length < 4) return bytes4(0);
        return bytes4(data[0]) | (bytes4(data[1]) >> 8) | (bytes4(data[2]) >> 16) | (bytes4(data[3]) >> 24);
    }

    function _nativeHolders(address extra) internal view returns (address[] memory out) {
        address[] memory base = _holders();
        out = new address[](base.length + 1);
        for (uint256 i = 0; i < base.length; i++) {
            out[i] = base[i];
        }
        out[base.length] = extra;
    }
}
