// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {
    CloseReason,
    Kind,
    KIND_COUNT,
    NATIVE_ASSET,
    QuoteReason,
    Range,
    RefundReason,
    REQUEST_WINDOW,
    SeedSkipReason,
    State
} from "../../src/Types.sol";
import {
    AlreadySeeded,
    BuysPaused,
    EntryWindowClosed,
    InsufficientSeedBalance,
    SeedAccountCannotBuy,
    SeedNotAuthorized,
    SeedNotConfigured
} from "../../src/Errors.sol";
import {LuckyDrawBase} from "./LuckyDrawBase.t.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice Operator seed entries and target closes
///         (SPEC §5.4, §6.2, D9, D10; ACCEPTANCE A07, A47, A48, A51–A56).
contract LuckyDrawSeedTargetTest is LuckyDrawBase {
    uint256 internal constant SEED = 0.05 ether;
    uint256 internal constant CAP = 1 ether;

    /// @dev Pool 2's asset has two decimals at USD 1: 5.00 TWO of seed and the USD 1 minimum of 1.00 TWO.
    uint256 internal constant TOKEN_SEED = 500;
    uint256 internal constant MIN_TOKEN = 100;

    /// @dev Smallest native pot worth USD 1,000 at USD 600 (the default weekly target).
    uint256 internal constant TARGET_NATIVE_1000 = 1_666_666_666_666_666_667;
    /// @dev Smallest native pot worth USD 10,000 at USD 600 (the default Day10k / Week10k target).
    uint256 internal constant TARGET_NATIVE_10000 = 16_666_666_666_666_666_667;
    /// @dev Smallest native pot worth USD 100,000 at USD 600 (the default Week100k / Month100k target).
    uint256 internal constant TARGET_NATIVE_100000 = 166_666_666_666_666_666_667;

    // ---- Seeding entry points (A47) -----------------------------------------

    // ---- Per-asset seed consent (SPEC §5.4, D9) -----------------------------

    /// @dev Pool 2 is a 2-decimal token, so a BNB-sized raw cap must buy no consent there at all.
    function test_Seed_ConsentIsPerAssetAndDoesNotCrossPools() public {
        _configureSeed(NATIVE_POOL, SEED, CAP); // BNB only: 1e18 raw units
        vm.prank(owner);
        draw.setSeedAmount(TOKEN_POOL, TOKEN_SEED);
        _depositNative(seedSafe, 10 ether);
        _depositToken(seedSafe, 1_000_000_00);

        // The authorized asset seeds.
        vm.prank(keeper);
        draw.seedRound(NATIVE_DAY);
        assertTrue(draw.getRound(NATIVE_DAY).seeded, "BNB consent seeds the BNB round");

        // The token pool does not, even though its seedAmount is a rounding error against the BNB cap.
        vm.prank(keeper);
        vm.expectRevert(SeedNotAuthorized.selector);
        draw.seedRound(TOKEN_DAY);
        assertEq(vault.balanceOf(seedSafe, address(tkn2)), 1_000_000_00, "no token debit");

        // The advisory view agrees: the quote models no pending seed for that round.
        _depositToken(carol, MIN_TOKEN);
        assertEq(
            draw.quoteBuy(TOKEN_DAY, carol, MIN_TOKEN).shareDenominatorAfter,
            MIN_TOKEN,
            "quoteBuy models no pending seed without consent for the asset"
        );

        // And the fallback inside `buy` skips with the matching reason instead of debiting.
        vm.expectEmit(true, false, false, true, address(draw));
        emit ILuckyDraw.SeedSkipped(TOKEN_DAY, SeedSkipReason.NotAuthorized);
        vm.prank(carol);
        draw.buy(TOKEN_DAY, MIN_TOKEN, 0, uint64(block.timestamp + 300));
        assertFalse(draw.getRound(TOKEN_DAY).seeded, "still unseeded");
        assertEq(vault.balanceOf(seedSafe, address(tkn2)), 1_000_000_00, "the token float is intact");
    }

    function test_Seed_TokenCapBelowTheTokenSeedAmountIsNotAuthorized() public {
        vm.startPrank(owner);
        draw.setSeedAccount(seedSafe);
        draw.setSeedAmount(TOKEN_POOL, TOKEN_SEED);
        vm.stopPrank();
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn2), TOKEN_SEED - 1);
        _depositToken(seedSafe, 1_000_000_00);

        vm.prank(keeper);
        vm.expectRevert(SeedNotAuthorized.selector);
        draw.seedRound(TOKEN_DAY);

        // Raising the asset's own cap to the seed amount is what unlocks it.
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn2), TOKEN_SEED);
        vm.prank(keeper);
        draw.seedRound(TOKEN_DAY);
        assertEq(draw.getRound(TOKEN_DAY).seedGross, TOKEN_SEED, "seeded at exactly the cap");
    }

    function test_Seed_AccountWithACapOnOneAssetStillBuysInAnother() public {
        _configureSeed(NATIVE_POOL, SEED, CAP); // consent for BNB only
        _depositNative(seedSafe, 10 ether);
        _depositToken(seedSafe, 1_000_000_00);

        // Blocked in the asset it consented to, in both the quote and the transaction.
        assertEq(
            uint8(draw.quoteBuy(NATIVE_DAY, seedSafe, MIN_NATIVE).reason),
            uint8(QuoteReason.SeedAccountCannotBuy),
            "quote refuses the consenting asset"
        );
        vm.prank(seedSafe);
        vm.expectRevert(SeedAccountCannotBuy.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));

        // An ordinary player in every other asset, and the quote says so first.
        assertEq(
            uint8(draw.quoteBuy(TOKEN_DAY, seedSafe, MIN_TOKEN).reason),
            uint8(QuoteReason.None),
            "quote admits the unconsented asset"
        );
        vm.prank(seedSafe);
        draw.buy(TOKEN_DAY, MIN_TOKEN, 0, uint64(block.timestamp + 300));
        (uint256 gross,,,) = draw.getPosition(TOKEN_DAY, seedSafe);
        assertEq(gross, MIN_TOKEN, "an ordinary entry");
    }

    // ---- `seedRound` obeys the buy pauses (SPEC §8.1) ------------------------

    function test_Seed_RevertWhen_BuysArePausedGlobally() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        _depositNative(seedSafe, 10 ether);

        vm.prank(owner);
        draw.setBuysPaused(true);
        vm.prank(keeper);
        vm.expectRevert(BuysPaused.selector);
        draw.seedRound(NATIVE_DAY);
        assertFalse(draw.getRound(NATIVE_DAY).seeded, "an incident freeze stops new entries of every kind");
        assertEq(vault.balanceOf(seedSafe, NATIVE_ASSET), 10 ether, "the seed Safe is not debited");

        vm.prank(owner);
        draw.setBuysPaused(false);
        vm.prank(keeper);
        draw.seedRound(NATIVE_DAY);
        assertTrue(draw.getRound(NATIVE_DAY).seeded, "seeding resumes on unpause");
    }

    function test_Seed_RevertWhen_TheRoundsPoolIsPaused() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        vm.prank(owner);
        draw.setSeedAmount(TOKEN_POOL, TOKEN_SEED);
        vm.prank(seedSafe);
        vault.authorizeSeed(address(tkn2), TOKEN_SEED);
        _depositNative(seedSafe, 10 ether);
        _depositToken(seedSafe, 1_000_000_00);

        vm.prank(owner);
        draw.setPoolBuysPaused(NATIVE_POOL, true);

        vm.prank(keeper);
        vm.expectRevert(BuysPaused.selector);
        draw.seedRound(NATIVE_DAY);

        // The pause is per pool: the other pool still seeds.
        vm.prank(keeper);
        draw.seedRound(TOKEN_DAY);
        assertTrue(draw.getRound(TOKEN_DAY).seeded, "an unpaused pool is unaffected");

        vm.prank(owner);
        draw.setPoolBuysPaused(NATIVE_POOL, false);
        vm.prank(keeper);
        draw.seedRound(NATIVE_DAY);
        assertTrue(draw.getRound(NATIVE_DAY).seeded, "seeding resumes on unpause");
    }

    function test_Seed_PausesDoNotChangeTheFallbackSeedInsideBuy() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        _depositNative(seedSafe, 10 ether);
        _depositNative(carol, MIN_NATIVE);

        // While paused the purchase itself is refused, so the fallback is never reached.
        vm.prank(owner);
        draw.setBuysPaused(true);
        vm.prank(carol);
        vm.expectRevert(BuysPaused.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));
        assertEq(
            uint8(draw.quoteBuy(NATIVE_DAY, carol, MIN_NATIVE).reason),
            uint8(QuoteReason.BuysPaused),
            "the quote reports the pause before it models a seed"
        );
        assertFalse(draw.getRound(NATIVE_DAY).seeded, "nothing seeded while paused");

        // Unpaused, the fallback behaves exactly as before: the seed enters ahead of the purchase.
        vm.prank(owner);
        draw.setBuysPaused(false);
        vm.expectEmit(true, true, false, false, address(draw));
        emit ILuckyDraw.SeedEntered(NATIVE_DAY, seedSafe, SEED, 0, 0, 0);
        vm.prank(carol);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));
        assertTrue(draw.getRound(NATIVE_DAY).seeded, "the fallback seed is unchanged");
        assertEq(draw.getRound(NATIVE_DAY).grossTotal, SEED + MIN_NATIVE, "seed first, then the purchase");
    }

    function test_Seed_AfterCreationThroughSeedRound() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        _depositNative(seedSafe, 10 ether);

        _warp(DAY_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);

        // Creation never seeds: the keeper seeds the new round in its next cycle (SPEC §5.4, §6.1).
        uint256 successor = draw.getCurrent(NATIVE_POOL, Kind.Day100);
        assertFalse(draw.getRound(successor).seeded, "not seeded at creation");
        assertEq(draw.getRound(successor).grossTotal, 0);

        vm.prank(keeper);
        draw.seedRound(successor);

        ILuckyDraw.RoundView memory round = draw.getRound(successor);
        assertTrue(round.seeded, "seeded by the keeper");
        assertEq(round.seedAccount, seedSafe);
        assertEq(round.seedGross, SEED);
        assertEq(round.grossTotal, SEED);
        assertEq(round.feeReserved, _fee(SEED), "the seed pays the same fee");
        assertEq(round.playerCount, 1, "the seed counts as one address");
        assertEq(vault.seedLocked(successor, seedSafe), SEED, "debited only through lockSeed");
    }

    function test_Seed_AtAddPoolForEveryKindsRound() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        MockERC20 t18 = new MockERC20("Eighteen", "E18", 18);
        MockAggregatorV3 feed3 = new MockAggregatorV3(FEED_DECIMALS);
        feed3.set(1, PRICE_600, block.timestamp);
        t18.mint(seedSafe, 100 ether);
        vm.startPrank(seedSafe);
        t18.approve(address(vault), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(owner);
        vault.listAsset(address(t18), 18);
        vault.setDepositsEnabled(address(t18), true);
        vm.stopPrank();
        vm.startPrank(seedSafe);
        vault.deposit(address(t18), 10 ether);
        // Consent is per asset: the native cap grants nothing here (SPEC §5.4).
        vault.authorizeSeed(address(t18), CAP);
        vm.stopPrank();

        vm.startPrank(owner);
        uint256 poolId = draw.addPool(address(t18), _pricing(address(feed3)));
        draw.setSeedAmount(poolId, SEED);
        vm.stopPrank();

        // Even with the seed fully configured and funded, `addPool` opens all KIND_COUNT rounds unseeded:
        // the keeper seeds each of them afterwards (SPEC §5.4, §6.1, ADR 036).
        for (uint256 k = 0; k < KIND_COUNT; ++k) {
            assertFalse(draw.getRound(draw.getCurrent(poolId, Kind(k))).seeded, "creation never seeds");
        }
        for (uint256 k = 0; k < KIND_COUNT; ++k) {
            uint256 roundId = draw.getCurrent(poolId, Kind(k));
            vm.prank(keeper);
            draw.seedRound(roundId);
            assertTrue(draw.getRound(roundId).seeded);
            assertEq(draw.getRound(roundId).seedGross, SEED);
        }
        assertEq(
            vault.balanceOf(seedSafe, address(t18)),
            10 ether - KIND_COUNT * SEED,
            "one capped debit per round, once per kind"
        );
    }

    function test_Seed_AtFirstPlayerPurchaseAndOnlyOnce() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        _depositNative(seedSafe, 10 ether);
        assertFalse(draw.getRound(NATIVE_DAY).seeded, "no round is seeded at creation");

        _depositNative(alice, 1 ether);
        _buy(alice, NATIVE_DAY, MIN_NATIVE);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertTrue(round.seeded);
        assertEq(round.playerCount, 2, "seed plus one player");
        assertEq(round.grossTotal, SEED + MIN_NATIVE);
        assertEq(round.rangeCount, 2);
        (Range[] memory page, uint256 next) = draw.getRanges(NATIVE_DAY, 0, 2);
        assertEq(next, 2);
        assertEq(page[0].buyer, seedSafe, "the seed range precedes the purchase");
        assertEq(page[0].cumulativeGross, SEED);
        assertEq(page[1].buyer, alice);

        _buy(alice, NATIVE_DAY, MIN_NATIVE);
        assertEq(draw.getRound(NATIVE_DAY).seedGross, SEED, "no second seed");
        assertEq(draw.getRound(NATIVE_DAY).rangeCount, 3);

        vm.prank(keeper);
        vm.expectRevert(AlreadySeeded.selector);
        draw.seedRound(NATIVE_DAY);
    }

    function test_Seed_IsExemptFromThePriceCheck() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        _depositNative(seedSafe, 10 ether);
        feed.setRevert(true, false); // no usable price at all

        vm.prank(keeper);
        draw.seedRound(NATIVE_DAY);
        assertTrue(draw.getRound(NATIVE_DAY).seeded, "the operator's own money at a fixed size");
    }

    // ---- Skip and revert reasons (A48, A55) ---------------------------------

    function test_Seed_SkipsWithoutRevertingTheEnclosingCall() public {
        // NotConfigured: no amount and no account.
        vm.prank(keeper);
        vm.expectRevert(SeedNotConfigured.selector);
        draw.seedRound(NATIVE_DAY);
        _expectSkip(NATIVE_DAY, SeedSkipReason.NotConfigured);

        // NotAuthorized: pointed at an account that never called authorizeSeed.
        vm.startPrank(owner);
        draw.setSeedAccount(dave);
        draw.setSeedAmount(NATIVE_POOL, SEED);
        vm.stopPrank();
        _depositNative(dave, 10 ether);
        vm.prank(keeper);
        vm.expectRevert(SeedNotAuthorized.selector);
        draw.seedRound(NATIVE_DAY);
        _expectSkip(NATIVE_DAY, SeedSkipReason.NotAuthorized);
        assertEq(vault.balanceOf(dave, NATIVE_ASSET), 10 ether, "an ordinary depositor is never debited");

        // NotAuthorized also covers a seedAmount above the account's own cap.
        _configureSeed(NATIVE_POOL, SEED, SEED - 1);
        _depositNative(seedSafe, 10 ether);
        vm.prank(keeper);
        vm.expectRevert(SeedNotAuthorized.selector);
        draw.seedRound(NATIVE_DAY);

        // InsufficientSeedBalance: authorized but unfunded.
        vm.prank(seedSafe);
        vault.authorizeSeed(NATIVE_ASSET, CAP);
        vm.prank(seedSafe);
        vault.withdraw(NATIVE_ASSET, 10 ether);
        vm.prank(keeper);
        vm.expectRevert(InsufficientSeedBalance.selector);
        draw.seedRound(NATIVE_DAY);
        _expectSkip(NATIVE_DAY, SeedSkipReason.InsufficientSeedBalance);
    }

    function test_Seed_RevertWhen_RoundNoLongerAccceptsEntries() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        _depositNative(seedSafe, 10 ether);
        _warp(DAY_CUTOFF);

        vm.prank(keeper);
        vm.expectRevert(EntryWindowClosed.selector);
        draw.seedRound(NATIVE_DAY);

        vm.prank(keeper);
        draw.closeRound(NATIVE_DAY);
        vm.prank(keeper);
        vm.expectRevert(EntryWindowClosed.selector);
        draw.seedRound(NATIVE_DAY);
        // `SeedSkipReason.NotOpen` is defensive only: `_trySeed` runs at creation, where the cutoff is always
        // in the future, and inside `buy`, which already rejects a closed or seeded round.
    }

    function test_Seed_UnfundedPoolFallsBackToInsufficientPlayers() public {
        vm.startPrank(owner);
        draw.setSeedAccount(seedSafe);
        draw.setSeedAmount(NATIVE_POOL, SEED);
        vm.stopPrank();

        _depositNative(alice, 1 ether);
        _buy(alice, NATIVE_DAY, MIN_NATIVE); // seed attempt skips: no authorization
        assertFalse(draw.getRound(NATIVE_DAY).seeded);

        _closeAtCutoff(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Refunding));
        assertEq(uint8(draw.getRound(NATIVE_DAY).refundReason), uint8(RefundReason.InsufficientPlayers));
    }

    function test_Seed_LonePlayerPlusSeedReachesAwaitingRequest() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        _depositNative(seedSafe, 10 ether);
        _depositNative(alice, 1 ether);
        _buy(alice, NATIVE_DAY, MIN_NATIVE);

        _closeAtCutoff(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.AwaitingRequest), "a lone player still draws");
    }

    function test_Seed_AccountCannotEnterThroughThePlayerPath() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        _depositNative(seedSafe, 10 ether);
        vm.prank(seedSafe);
        vm.expectRevert(SeedAccountCannotBuy.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));
    }

    // ---- Void returns the seed (A07, A56) -----------------------------------

    function test_Void_ReturnsTheSeedToTheAccountThatFundedIt() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        _depositNative(seedSafe, 10 ether);
        vm.prank(keeper);
        draw.seedRound(NATIVE_DAY);
        uint256 seedBalance = vault.balanceOf(seedSafe, NATIVE_ASSET);

        // The owner repoints the seed before the round closes; the round keeps its own account.
        vm.prank(dave);
        vault.authorizeSeed(NATIVE_ASSET, CAP);
        vm.prank(owner);
        draw.setSeedAccount(dave);

        _warp(DAY_CUTOFF);
        vm.prank(keeper);
        vm.expectEmit(true, true, false, true, address(draw));
        emit ILuckyDraw.Refunded(NATIVE_DAY, seedSafe, SEED);
        draw.closeRound(NATIVE_DAY);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(uint8(round.state), uint8(State.Void));
        assertEq(round.refundedGross, SEED);
        assertEq(vault.balanceOf(seedSafe, NATIVE_ASSET) - seedBalance, SEED, "returned to A, not to B");
        assertEq(vault.balanceOf(dave, NATIVE_ASSET), 0, "the new pointer is unaffected");
        assertEq(vault.getEscrow(NATIVE_DAY).amount, 0, "escrow zero in Void");
        assertEq(draw.getRound(NATIVE_DAY).requestId, 0, "a seed-only round never requests randomness");
    }

    function test_Void_WithoutASeedCreditsNobody() public {
        _closeAtCutoff(NATIVE_DAY);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Void));
        assertEq(draw.getRound(NATIVE_DAY).refundedGross, 0);
        assertEq(vault.totalEscrow(NATIVE_ASSET), 0);
    }

    // ---- Target closes (A51–A54) --------------------------------------------

    function test_Target_PurchaseClosesTheRoundAndOpensTheSuccessor() public {
        _configureSeed(NATIVE_POOL, SEED, CAP);
        _depositNative(seedSafe, 10 ether);
        _depositNative(alice, 1 ether);
        _depositNative(bob, 1 ether);

        _buy(alice, NATIVE_DAY, 0.05 ether); // seed 0.05 + alice 0.05 = USD 60, below the USD 100 target
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Open));

        uint256 remaining = TARGET_NATIVE_100 - draw.getRound(NATIVE_DAY).grossTotal;
        assertTrue(draw.quoteBuy(NATIVE_DAY, bob, remaining).reachesTarget, "quote predicts the close");
        assertFalse(draw.quoteBuy(NATIVE_DAY, bob, remaining - 1).reachesTarget, "one raw unit less does not");

        _buy(bob, NATIVE_DAY, remaining);

        ILuckyDraw.RoundView memory round = draw.getRound(NATIVE_DAY);
        assertEq(uint8(round.state), uint8(State.AwaitingRequest));
        assertEq(uint8(round.closeReason), uint8(CloseReason.TargetReached));
        assertEq(round.closedAt, uint64(block.timestamp));
        assertEq(round.requestDeadline, uint64(block.timestamp) + REQUEST_WINDOW);
        assertEq(round.grossTotal, TARGET_NATIVE_100);
        assertTrue(round.closedAt < round.closesAt, "closed before its cutoff");

        uint256 successor = draw.getCurrent(NATIVE_POOL, Kind.Day100);
        assertTrue(successor != NATIVE_DAY && successor != 0, "successor opened in the same transaction");
        assertFalse(draw.getRound(successor).seeded, "but not seeded: the keeper does that in its next cycle");
        vm.prank(keeper);
        draw.seedRound(successor);
        assertTrue(draw.getRound(successor).seeded);

        // A purchase that loses the race sees EntryWindowClosed with nothing debited.
        uint256 balanceBefore = vault.balanceOf(alice, NATIVE_ASSET);
        vm.prank(alice);
        vm.expectRevert(EntryWindowClosed.selector);
        draw.buy(NATIVE_DAY, MIN_NATIVE, 0, uint64(block.timestamp + 300));
        assertEq(vault.balanceOf(alice, NATIVE_ASSET), balanceBefore);
    }

    function test_Target_LonePlayerAndSeedAloneNeverClose() public {
        _configureSeed(NATIVE_POOL, 0.2 ether, CAP);
        _depositNative(seedSafe, 10 ether);
        vm.prank(keeper);
        draw.seedRound(NATIVE_DAY); // the seed alone is already worth USD 120
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.Open), "a seed entry never closes a round");

        // A lone player at the target in an unseeded pool also stays Open: one address is not two.
        _depositToken(alice, 100_100); // USD 1,000 of the 2-decimal token (the weekly target) plus USD 1 to quote
        vm.prank(alice);
        draw.buy(TOKEN_WEEK, 100_000, 0, uint64(block.timestamp + 300));
        // A rejected quote carries no projection (SPEC 8.1), so the follow-up quote must stay funded.
        assertEq(draw.quoteBuy(TOKEN_WEEK, alice, 100).usdValueBefore, 1000, "already at the target");
        assertFalse(draw.quoteBuy(TOKEN_WEEK, alice, 100).reachesTarget, "one address is not two");
        assertEq(uint8(_state(TOKEN_WEEK)), uint8(State.Open), "one address is not two");

        // The next player purchase in the seeded round closes it as TargetReached.
        _depositNative(alice, 1 ether);
        _buy(alice, NATIVE_DAY, MIN_NATIVE);
        assertEq(uint8(_state(NATIVE_DAY)), uint8(State.AwaitingRequest));
        assertEq(uint8(draw.getRound(NATIVE_DAY).closeReason), uint8(CloseReason.TargetReached));
    }

    function test_Target_BoundaryAtTheSpecWorkedExample() public {
        _depositNative(alice, 10 ether);
        _depositNative(bob, 10 ether);

        // One raw unit below USD 1,000 leaves the weekly round open.
        _buy(alice, NATIVE_WEEK, TARGET_NATIVE_1000 - 1 - MIN_NATIVE);
        _buy(bob, NATIVE_WEEK, MIN_NATIVE);
        assertEq(draw.getRound(NATIVE_WEEK).grossTotal, TARGET_NATIVE_1000 - 1);
        assertEq(uint8(_state(NATIVE_WEEK)), uint8(State.Open), "values at USD 999");

        _buy(alice, NATIVE_WEEK, MIN_NATIVE);
        assertEq(uint8(_state(NATIVE_WEEK)), uint8(State.AwaitingRequest), "one more unit reaches USD 1,000");
    }

    function test_Target_RequestDeadlineIsTwentyFourHoursNotMonthEnd() public {
        // Close the first monthly round and take its successor, which runs 2026-10-01 to 2026-11-01.
        _warp(MONTH_CUTOFF);
        vm.prank(keeper);
        draw.closeRound(NATIVE_MONTH);
        uint256 monthly = draw.getCurrent(NATIVE_POOL, Kind.Month100k);
        assertEq(draw.getRound(monthly).closesAt, 1_793_491_200, "2026-11-01 00:00 UTC");

        _warp(1_790_942_400); // 2026-10-02 12:00 UTC, day two of the month
        _depositNative(alice, 200 ether);
        _depositNative(bob, 200 ether);
        _buy(alice, monthly, TARGET_NATIVE_100000 - MIN_NATIVE);
        _buy(bob, monthly, MIN_NATIVE);

        ILuckyDraw.RoundView memory round = draw.getRound(monthly);
        assertEq(uint8(round.closeReason), uint8(CloseReason.TargetReached));
        assertEq(round.closedAt, 1_790_942_400);
        assertEq(round.requestDeadline, 1_790_942_400 + REQUEST_WINDOW, "24 hours, not month end");

        vm.warp(round.requestDeadline);
        vm.prank(keeper);
        draw.expireUnrequested(monthly);
        vm.prank(keeper);
        draw.claimRefund(monthly, bob);
        assertEq(draw.getRound(monthly).refundedGross, MIN_NATIVE);
    }

    // ---- Helpers ------------------------------------------------------------

    /// @dev A player purchase on an unseeded round retries the seed, so the skip reason is observable there.
    function _expectSkip(uint256 roundId, SeedSkipReason reason) private {
        _depositNative(carol, MIN_NATIVE);
        vm.expectEmit(true, false, false, true, address(draw));
        emit ILuckyDraw.SeedSkipped(roundId, reason);
        vm.prank(carol);
        draw.buy(roundId, MIN_NATIVE, 0, uint64(block.timestamp + 300));
    }
}
