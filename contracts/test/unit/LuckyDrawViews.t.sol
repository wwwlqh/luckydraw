// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {Kind, NATIVE_ASSET, PricingConfig, QuoteReason, Range, State} from "../../src/Types.sol";
import {
    AlreadyListed,
    InvalidAmount,
    InvalidAsset,
    InvalidConfig,
    InvalidId,
    InvalidRecipient,
    SeedAccountCannotBuy,
    WrongState
} from "../../src/Errors.sol";
import {LuckyDrawBase} from "./LuckyDrawBase.t.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Views, quotes, pagination and owner authority limits
///         (SPEC §8.1; ACCEPTANCE A30, A32, A35, A36, A45).
contract LuckyDrawViewsTest is LuckyDrawBase {
    // ---- Round and pool views ------------------------------------------------

    function test_Views_RoundCarriesItsFrozenTerms() public view {
        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(round.id, NATIVE_DAY);
        assertEq(round.poolId, NATIVE_POOL);
        assertEq(uint8(round.kind), uint8(Kind.Day100));
        assertEq(round.sequence, 1);
        assertEq(round.asset, NATIVE_ASSET);
        assertEq(round.tokenDecimals, 18);
        assertEq(round.pricing.feed, address(feed));
        assertEq(round.pricing.feedDecimals, FEED_DECIMALS);
        assertEq(round.feeAccount, feeAcc);
        assertEq(round.opensAt, START);
        assertEq(round.closesAt, DAY_CUTOFF);
        assertEq(round.targetUsd, 100, "default Day100 target");
        assertEq(draw.getRound(NATIVE_DAY_1K).targetUsd, 1000);
        assertEq(draw.getRound(NATIVE_DAY_10K).targetUsd, 10_000);
        assertEq(draw.getRound(NATIVE_WEEK).targetUsd, 1000);
        assertEq(draw.getRound(NATIVE_WEEK_10K).targetUsd, 10_000);
        assertEq(draw.getRound(NATIVE_WEEK_100K).targetUsd, 100_000);
        assertEq(draw.getRound(NATIVE_MONTH).targetUsd, 100_000);
        assertEq(uint8(round.state), uint8(State.Open));
        assertEq(round.rangeCount, 0);
    }

    function test_Views_PoolCarriesItsConfiguration() public {
        vm.startPrank(owner);
        draw.setSeedAmount(NATIVE_POOL, 7 ether);
        draw.setTargetUsd(NATIVE_POOL, Kind.Week1k, 2500);
        vm.stopPrank();

        ILuckyDraw.PoolView memory pool = draw.getPool(NATIVE_POOL);
        assertEq(pool.id, NATIVE_POOL);
        assertEq(pool.asset, NATIVE_ASSET);
        assertTrue(pool.enabled);
        assertFalse(pool.buysPaused);
        assertEq(pool.seedAmount, 7 ether);
        assertEq(pool.nextPricing.feed, address(feed));
        assertEq(pool.targetUsd[0], 100, "Day100 default");
        assertEq(pool.targetUsd[1], 1000, "Day1k default");
        assertEq(pool.targetUsd[2], 10_000, "Day10k default");
        assertEq(pool.targetUsd[3], 2500, "Week1k overridden");
        assertEq(pool.targetUsd[4], 10_000, "Week10k default");
        assertEq(pool.targetUsd[5], 100_000, "Week100k default");
        assertEq(pool.targetUsd[6], 100_000, "Month100k default");
        assertEq(draw.getRound(NATIVE_WEEK).targetUsd, 1000, "a live round keeps its own target");
    }

    function test_Views_UnknownIdsRevert() public {
        vm.expectRevert(InvalidId.selector);
        draw.getPool(99);
        vm.expectRevert(InvalidId.selector);
        draw.getRound(99);
        vm.expectRevert(InvalidId.selector);
        draw.getPosition(99, alice);
        assertEq(draw.getCurrent(99, Kind.Day100), 0, "an unknown pool has no current round");
        assertEq(draw.getRequest(99), 0, "an unknown request maps to nothing");
    }

    function test_Views_SeedAccountPointerAndRequestMap() public {
        assertEq(draw.getSeedAccount(), address(0));
        _configureSeed(NATIVE_POOL, 0.05 ether, 1 ether);
        assertEq(draw.getSeedAccount(), seedSafe);

        _depositNative(alice, 1 ether);
        _depositNative(bob, 1 ether);
        _buy(alice, NATIVE_DAY, MIN_NATIVE);
        _buy(bob, NATIVE_DAY, MIN_NATIVE);
        _closeAtCutoff(NATIVE_DAY);
        uint256 requestId = _request(NATIVE_DAY);
        assertEq(draw.getRequest(requestId), NATIVE_DAY, "byRequest is injective");
        assertEq(draw.pendingRequests(), 1);
    }

    // ---- Pagination (A36) ----------------------------------------------------

    function test_Views_PaginationLimitsAndEndCursors() public {
        _depositToken(alice, 1000);
        for (uint256 i = 0; i < 5; ++i) {
            vm.prank(alice);
            draw.buy(TOKEN_DAY, 100, 0, uint64(block.timestamp + 300));
        }

        vm.expectRevert(InvalidAmount.selector);
        draw.getRanges(TOKEN_DAY, 0, 0);
        vm.expectRevert(InvalidAmount.selector);
        draw.getRanges(TOKEN_DAY, 0, 101);
        vm.expectRevert(InvalidAmount.selector);
        draw.getPools(0, 0);
        vm.expectRevert(InvalidAmount.selector);
        draw.getPools(0, 101);

        (Range[] memory page, uint256 next) = draw.getRanges(TOKEN_DAY, 0, 2);
        assertEq(page.length, 2);
        assertEq(next, 2);
        (page, next) = draw.getRanges(TOKEN_DAY, next, 100);
        assertEq(page.length, 3, "partial last page");
        assertEq(next, 5);
        (page, next) = draw.getRanges(TOKEN_DAY, 5, 100);
        assertEq(page.length, 0, "cursor at the end returns an empty page");
        assertEq(next, 5);
        (page, next) = draw.getRanges(TOKEN_DAY, 500, 100);
        assertEq(page.length, 0, "cursor past the end returns an empty page");
        assertEq(next, 500);

        (ILuckyDraw.PoolView[] memory pools, uint256 poolCursor) = draw.getPools(0, 100);
        assertEq(pools.length, 2);
        assertEq(pools[0].id, 1);
        assertEq(pools[1].id, 2);
        assertEq(poolCursor, 2);
        (pools, poolCursor) = draw.getPools(2, 1);
        assertEq(pools.length, 0);
    }

    // ---- quoteBuy never reverts (A32) ---------------------------------------

    function test_Quote_ReportsTheFirstFailingCheckWithoutReverting() public {
        assertEq(uint8(draw.quoteBuy(999, alice, 100).reason), uint8(QuoteReason.InvalidRound));

        // Zero amount outranks everything after the window check.
        assertEq(uint8(draw.quoteBuy(NATIVE_DAY, alice, 0).reason), uint8(QuoteReason.InvalidAmount));

        // Paused outranks the price and the minimum.
        vm.prank(owner);
        draw.setBuysPaused(true);
        assertEq(uint8(draw.quoteBuy(NATIVE_DAY, alice, 1).reason), uint8(QuoteReason.BuysPaused));
        vm.prank(owner);
        draw.setBuysPaused(false);

        // Below minimum outranks the balance check.
        assertEq(uint8(draw.quoteBuy(NATIVE_DAY, alice, 1).reason), uint8(QuoteReason.BelowMinimum));

        // With a valid amount and no balance, the balance check reports.
        ILuckyDraw.Quote memory quote = draw.quoteBuy(NATIVE_DAY, alice, MIN_NATIVE);
        assertEq(uint8(quote.reason), uint8(QuoteReason.InsufficientBalance));
        assertEq(quote.minGross, MIN_NATIVE);
        assertEq(quote.closesAt, DAY_CUTOFF);

        _depositNative(alice, 1 ether);
        assertEq(uint8(draw.quoteBuy(NATIVE_DAY, alice, MIN_NATIVE).reason), uint8(QuoteReason.None));

        // A closed round is reported as EntryWindowClosed, matching buy.
        _warp(DAY_CUTOFF);
        assertEq(uint8(draw.quoteBuy(NATIVE_DAY, alice, MIN_NATIVE).reason), uint8(QuoteReason.EntryWindowClosed));
    }

    function test_Quote_ReportsSharesFeesAndTargetProgress() public {
        _depositNative(alice, 10 ether);
        _depositNative(bob, 10 ether);
        _buy(alice, NATIVE_DAY, 0.1 ether);

        ILuckyDraw.Quote memory quote = draw.quoteBuy(NATIVE_DAY, bob, 0.05 ether);
        assertEq(uint8(quote.reason), uint8(QuoteReason.None));
        assertEq(quote.shareNumeratorBefore, 0, "bob owns nothing yet");
        assertEq(quote.shareDenominatorBefore, 0.1 ether);
        assertEq(quote.shareNumeratorAfter, 0.05 ether);
        assertEq(quote.shareDenominatorAfter, 0.15 ether);
        assertEq(quote.feeDelta, _fee(0.15 ether) - _fee(0.1 ether));
        assertEq(quote.netDelta, 0.05 ether - quote.feeDelta);
        assertEq(quote.usdValueBefore, 60, "0.1 BNB at USD 600");
        assertEq(quote.usdValueAfter, 90);
        assertFalse(quote.reachesTarget, "USD 90 is below the USD 100 target");
        assertEq(quote.observation.answer, PRICE_600);
        assertEq(quote.observation.updatedAt, START);

        // The exact remaining amount reaches the target, and the quote says so.
        uint256 remaining = TARGET_NATIVE_100 - 0.1 ether;
        assertTrue(draw.quoteBuy(NATIVE_DAY, bob, remaining).reachesTarget);
        assertEq(draw.quoteBuy(NATIVE_DAY, bob, remaining).usdValueAfter, 100);
    }

    function test_Quote_ModelsThePendingSeedEntry() public {
        _configureSeed(NATIVE_POOL, 0.05 ether, 1 ether);
        _depositNative(seedSafe, 10 ether);
        _depositNative(alice, 10 ether);

        ILuckyDraw.Quote memory quote = draw.quoteBuy(NATIVE_DAY, alice, 0.05 ether);
        assertEq(quote.shareDenominatorAfter, 0.1 ether, "the seed enters first");
        assertEq(quote.feeDelta, _fee(0.1 ether) - _fee(0.05 ether), "fee on cumulative gross after the seed");

        _buy(alice, NATIVE_DAY, 0.05 ether);
        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(round.grossTotal, quote.shareDenominatorAfter, "execution matches the quote");
        assertEq(round.feeReserved, _fee(0.1 ether));
    }

    function test_Quote_RejectsAuthorizedSeedAccountAndAllowsRevocation() public {
        _configureSeed(NATIVE_POOL, 0.02 ether, 1 ether);
        _depositNative(seedSafe, 1 ether);
        assertEq(uint8(draw.quoteBuy(NATIVE_DAY, seedSafe, 0.01 ether).reason), uint8(QuoteReason.SeedAccountCannotBuy));
        vm.prank(seedSafe);
        vm.expectRevert(SeedAccountCannotBuy.selector);
        draw.buy(NATIVE_DAY, 0.01 ether, 0, uint64(block.timestamp + 300));
        assertEq(vault.balanceOf(seedSafe, NATIVE_ASSET), 1 ether, "rejection debits nothing");

        vm.prank(seedSafe);
        vault.authorizeSeed(NATIVE_ASSET, 0);
        assertEq(uint8(draw.quoteBuy(NATIVE_DAY, seedSafe, 0.01 ether).reason), uint8(QuoteReason.None));
        _buy(seedSafe, NATIVE_DAY, 0.01 ether);
    }

    function test_Quote_SeedRestrictionPrecedesBalanceButFollowsMinimum() public {
        vm.prank(alice);
        vault.authorizeSeed(NATIVE_ASSET, 1 ether);
        assertEq(uint8(draw.quoteBuy(NATIVE_DAY, alice, 1).reason), uint8(QuoteReason.BelowMinimum));
        assertEq(uint8(draw.quoteBuy(NATIVE_DAY, alice, MIN_NATIVE).reason), uint8(QuoteReason.SeedAccountCannotBuy));
        vm.prank(alice);
        vm.expectRevert(SeedAccountCannotBuy.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));
    }

    function test_Quote_UnfundedHugeInputReturnsReasonWithoutUsdOverflow() public {
        feed2.set(2, 600e8, block.timestamp);
        ILuckyDraw.Quote memory quote = draw.quoteBuy(TOKEN_DAY, alice, type(uint256).max);
        assertEq(uint8(quote.reason), uint8(QuoteReason.InsufficientBalance));
        assertEq(quote.minGross, 1);
        assertEq(quote.usdValueAfter, 0, "rejected projections are unavailable");
        assertFalse(quote.reachesTarget);
    }

    function test_Quote_ExistingSeedWithUnrepresentableUsdReturnsOverflow() public {
        uint256 largeSeed = uint256(1) << 254;
        _configureSeed(TOKEN_POOL, largeSeed, largeSeed);
        tkn2.mint(seedSafe, largeSeed);
        _depositToken(seedSafe, largeSeed);
        draw.seedRound(TOKEN_DAY);
        _depositToken(alice, 100);
        feed2.set(2, 600e8, block.timestamp);
        assertEq(uint8(draw.quoteBuy(TOKEN_DAY, alice, 100).reason), uint8(QuoteReason.ArithmeticOverflow));

        _warp(DAY_CUTOFF);
        feed2.set(3, 600e8, block.timestamp);
        assertEq(uint8(draw.quoteBuy(TOKEN_DAY, alice, type(uint256).max).reason), uint8(QuoteReason.EntryWindowClosed));
    }

    function test_Quote_FundedUnrepresentableUsdReturnsOverflow() public {
        uint256 largeAmount = uint256(1) << 254;
        tkn2.mint(alice, largeAmount);
        _depositToken(alice, largeAmount);
        feed2.set(2, 600e8, block.timestamp);
        assertEq(uint8(draw.quoteBuy(TOKEN_DAY, alice, largeAmount).reason), uint8(QuoteReason.ArithmeticOverflow));
    }

    function testFuzz_QuoteUnfundedAmountNeverReverts(uint256 gross, uint128 price) public {
        price = uint128(bound(price, 1, type(uint128).max));
        feed2.set(2, int256(uint256(price)), block.timestamp);
        ILuckyDraw.Quote memory quote = draw.quoteBuy(TOKEN_DAY, alice, gross);
        QuoteReason expected = gross == 0
            ? QuoteReason.InvalidAmount
            : gross < quote.minGross ? QuoteReason.BelowMinimum : QuoteReason.InsufficientBalance;
        assertEq(uint8(quote.reason), uint8(expected));
    }

    // ---- Owner authority (A30, A35, A45) ------------------------------------

    function test_Owner_SettersValidateAndEmitTypedChanges() public {
        vm.startPrank(owner);

        vm.expectEmit(false, false, false, true, address(draw));
        emit ILuckyDraw.BuysPausedSet(owner, false, true);
        draw.setBuysPaused(true);

        vm.expectEmit(true, false, false, true, address(draw));
        emit ILuckyDraw.PoolBuysPausedSet(NATIVE_POOL, owner, false, true);
        draw.setPoolBuysPaused(NATIVE_POOL, true);

        vm.expectEmit(true, false, false, true, address(draw));
        emit ILuckyDraw.PoolEnabledSet(NATIVE_POOL, owner, true, false);
        draw.setPoolEnabled(NATIVE_POOL, false);

        vm.expectEmit(true, false, false, true, address(draw));
        emit ILuckyDraw.SeedAmountSet(NATIVE_POOL, owner, 0, 1 ether);
        draw.setSeedAmount(NATIVE_POOL, 1 ether);

        vm.expectEmit(true, false, false, true, address(draw));
        emit ILuckyDraw.TargetUsdSet(NATIVE_POOL, Kind.Day100, owner, 100, 250);
        draw.setTargetUsd(NATIVE_POOL, Kind.Day100, 250);

        vm.expectEmit(false, false, false, true, address(draw));
        emit ILuckyDraw.FeeAccountSet(owner, feeAcc, dave);
        draw.setFeeAccount(dave);

        vm.expectEmit(false, false, false, true, address(draw));
        emit ILuckyDraw.SeedAccountSet(owner, address(0), seedSafe);
        draw.setSeedAccount(seedSafe);

        vm.stopPrank();
    }

    function test_Owner_SettersRejectInvalidInput() public {
        vm.startPrank(owner);
        vm.expectRevert(InvalidConfig.selector);
        draw.setTargetUsd(NATIVE_POOL, Kind.Day100, 9);
        draw.setTargetUsd(NATIVE_POOL, Kind.Day100, 10);

        vm.expectRevert(InvalidRecipient.selector);
        draw.setFeeAccount(address(0));
        vm.expectRevert(InvalidRecipient.selector);
        draw.setFeeAccount(address(vault));
        vm.expectRevert(InvalidRecipient.selector);
        draw.setFeeAccount(address(draw));
        vm.expectRevert(InvalidRecipient.selector);
        draw.setSeedAccount(address(0));
        vm.expectRevert(InvalidRecipient.selector);
        draw.setSeedAccount(address(vault));

        vm.expectRevert(InvalidId.selector);
        draw.setSeedAmount(42, 1);
        vm.expectRevert(InvalidId.selector);
        draw.setPoolEnabled(42, true);
        vm.expectRevert(InvalidId.selector);
        draw.setNextPricing(42, _pricing(address(feed)));

        PricingConfig memory bad = _pricing(address(feed));
        bad.maxPriceAge = 59;
        vm.expectRevert(InvalidConfig.selector);
        draw.setNextPricing(NATIVE_POOL, bad);
        vm.stopPrank();
    }

    function test_Owner_OnlyTheOwnerMayConfigure() public {
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        draw.setBuysPaused(true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        draw.addPool(NATIVE_ASSET, _pricing(address(feed)));
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        draw.setSeedAccount(alice);
        vm.stopPrank();
    }

    function test_AddPool_Rules() public {
        vm.startPrank(owner);
        vm.expectRevert(AlreadyListed.selector);
        draw.addPool(NATIVE_ASSET, _pricing(address(feed)));

        vm.expectRevert(InvalidAsset.selector);
        draw.addPool(makeAddr("unlisted"), _pricing(address(feed)));

        MockERC20 fresh = new MockERC20("Fresh", "FRSH", 18);
        vault.listAsset(address(fresh), 18);
        PricingConfig memory bad = _pricing(address(feed));
        bad.feedDecimals = 9; // does not match the feed's own decimals()
        vm.expectRevert(InvalidConfig.selector);
        draw.addPool(address(fresh), bad);

        bad = _pricing(makeAddr("noCode"));
        vm.expectRevert(InvalidConfig.selector);
        draw.addPool(address(fresh), bad);
        vm.stopPrank();
    }

    function test_AddPool_RevertWhen_VaultIsBoundToAnotherDraw() public {
        LuckyDraw other = new LuckyDraw(
            address(vault),
            address(coordinator),
            subId,
            KEY_HASH,
            CONFIRMATIONS,
            CALLBACK_GAS,
            MAX_REQUEST_COST,
            feeAcc,
            owner
        );
        vm.prank(owner);
        vm.expectRevert(WrongState.selector);
        other.addPool(NATIVE_ASSET, _pricing(address(feed)));
    }

    function test_Constructor_RejectsUnusableConfiguration() public {
        vm.expectRevert(InvalidConfig.selector);
        new LuckyDraw(address(0), address(coordinator), subId, KEY_HASH, CONFIRMATIONS, CALLBACK_GAS, 1, feeAcc, owner);
        vm.expectRevert(InvalidConfig.selector);
        new LuckyDraw(address(vault), address(coordinator), subId, KEY_HASH, CONFIRMATIONS, 0, 1, feeAcc, owner);
        vm.expectRevert(InvalidConfig.selector);
        new LuckyDraw(
            address(vault), address(coordinator), subId, KEY_HASH, CONFIRMATIONS, CALLBACK_GAS, 0, feeAcc, owner
        );
        vm.expectRevert(InvalidRecipient.selector);
        new LuckyDraw(
            address(vault), address(coordinator), subId, KEY_HASH, CONFIRMATIONS, CALLBACK_GAS, 1, address(vault), owner
        );
    }

    function test_Ownership_TwoStepWithNoZeroOwnerAndNoRenounce() public {
        vm.prank(owner);
        vm.expectRevert(InvalidRecipient.selector);
        draw.transferOwnership(address(0));

        vm.prank(owner);
        vm.expectRevert(InvalidRecipient.selector);
        draw.renounceOwnership();

        vm.prank(owner);
        draw.transferOwnership(dave);
        assertEq(draw.owner(), owner, "not transferred until accepted");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        draw.acceptOwnership();
        vm.prank(dave);
        draw.acceptOwnership();
        assertEq(draw.owner(), dave);
    }

    /// @notice No fee, price, winner, coordinator, sweep or arbitrary-call entry point exists (A30, D6).
    function test_Owner_ForbiddenEntryPointsDoNotExist() public {
        string[8] memory signatures = [
            "setFee(uint256)",
            "setTicketPrice(uint256)",
            "setCoordinator(address)",
            "setVault(address)",
            "fulfillRandomWords(uint256,uint256[])",
            "setWinner(uint256,address)",
            "sweep(address,uint256)",
            "execute(address,bytes)"
        ];
        for (uint256 i = 0; i < signatures.length; ++i) {
            (bool ok,) = address(draw).call(abi.encodeWithSignature(signatures[i], 0));
            assertFalse(ok, signatures[i]);
        }
    }
}
