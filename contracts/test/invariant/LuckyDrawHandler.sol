// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {GhostLedger} from "./GhostLedger.sol";
import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyVault} from "../../src/LuckyVault.sol";
import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {
    CloseReason,
    KIND_COUNT,
    Kind,
    NATIVE_ASSET,
    PricingConfig,
    QuoteReason,
    ReferenceKind,
    RefundReason,
    REQUEST_WINDOW,
    State
} from "../../src/Types.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockVRFCoordinatorV2Plus} from "../mocks/MockVRFCoordinatorV2Plus.sol";

/// @title LuckyDrawHandler
/// @notice The generated-action surface of the stateful campaign (SPEC §11.2 "Stateful").
/// @dev Every protocol call is wrapped in try/catch, so a handler call never reverts and the fuzzer never
///      discards a step silently. Each action ends in exactly one of three buckets:
///      applied (the call succeeded and the ghost advanced), reverted (the call was rejected, deliberately or
///      because a guard fired) or skipped (no call was made because no eligible target existed). Inputs are
///      bounded to satisfiable ranges so that the reverted share stays far below the 20% ceiling; the
///      deliberately invalid actions are concentrated in `actBuyInvalid` and in the explicit revert branches.
contract LuckyDrawHandler is GhostLedger {
    // ---------------------------------------------------------------------
    // Action identifiers (per-type counters are reported for the campaign record)
    // ---------------------------------------------------------------------

    uint8 public constant A_DEPOSIT = 0;
    uint8 public constant A_WITHDRAW = 1;
    uint8 public constant A_BUY = 2;
    uint8 public constant A_BUY_LARGE = 3;
    uint8 public constant A_BUY_TARGET = 4;
    uint8 public constant A_BUY_INVALID = 5;
    uint8 public constant A_SEED = 6;
    uint8 public constant A_WARP = 7;
    uint8 public constant A_CLOSE = 8;
    uint8 public constant A_ENSURE = 9;
    uint8 public constant A_REQUEST = 10;
    uint8 public constant A_FULFILL = 11;
    uint8 public constant A_FULFILL_EDGE = 12;
    uint8 public constant A_EXPIRE = 13;
    uint8 public constant A_SETTLE = 14;
    uint8 public constant A_CLAIM = 15;
    uint8 public constant A_PAUSE = 16;
    uint8 public constant A_CONFIG = 17;
    uint8 public constant A_PRICE = 18;
    uint8 public constant A_COORD = 19;
    uint8 public constant A_DONATE = 20;
    uint8 public constant A_DURESS = 21;
    uint8 public constant A_COUNT = 22;

    mapping(uint8 action => uint256 count) public appliedOf;
    mapping(uint8 action => uint256 count) public revertedOf;
    mapping(uint8 action => uint256 count) public skippedOf;
    uint256 public totalApplied;
    uint256 public totalReverted;
    uint256 public totalSkipped;
    string[22] private _actionNames;

    /// @dev Why an intended purchase was skipped rather than forced into a revert, indexed by `QuoteReason`.
    ///      Reported so the campaign record shows which admission checks the generated traffic actually met.
    mapping(uint8 quoteReason => uint256 count) public quoteSkips;

    /// @dev Why a seed attempt was rejected, by the classification of `_seedCode` (SPEC §5.4).
    mapping(uint8 seedCode => uint256 count) public seedSkips;

    /// @dev Requests the mock coordinator has already delivered once. A delivery the consumer ignored (a
    ///      malformed payload) still consumes the request, exactly like the real coordinator, so the round
    ///      stays Drawing for good and no further delivery is possible (SPEC §7.3).
    mapping(uint256 requestId => bool) public delivered;

    // ---------------------------------------------------------------------
    // Actors and wiring
    // ---------------------------------------------------------------------

    struct Wiring {
        LuckyDraw draw;
        LuckyVault vault;
        MockERC20 token;
        MockVRFCoordinatorV2Plus coordinator;
        MockAggregatorV3 nativeFeed;
        MockAggregatorV3 tokenFeed;
        address owner;
        address keeper;
        address feeAccount;
        address[4] players;
        address[2] seedSafes;
    }

    MockVRFCoordinatorV2Plus internal coordinator;
    MockAggregatorV3[2] internal feeds; // index matches `assets`
    address internal owner;
    address internal keeper;
    address internal feeAccount;
    address[4] internal players;
    address[2] internal seedSafes;

    /// @dev Feed drivers. Mode 0 is a healthy feed that the warp helper keeps republishing; any other mode is
    ///      a deliberate degradation left in place until the next healthy update (SPEC §3.2, A40, A44).
    uint8[2] internal feedMode;
    int256[2] internal feedPrice;
    uint80[2] internal feedRound;
    uint32 internal constant MAX_AGE = 3600;
    uint8 internal constant FEED_DECIMALS = 8;

    uint256 internal constant SEED_NATIVE = 0.01 ether; // USD 6 at the fixture price
    uint256 internal constant SEED_TOKEN = 500; // USD 5 in a 2-decimal token at USD 1
    uint256 internal constant SEED_CAP = 1 ether; // authorised by each seed Safe itself

    constructor(Wiring memory w) {
        draw = w.draw;
        vault = w.vault;
        token = w.token;
        coordinator = w.coordinator;
        feeds = [w.nativeFeed, w.tokenFeed];
        owner = w.owner;
        keeper = w.keeper;
        feeAccount = w.feeAccount;
        players = w.players;
        seedSafes = w.seedSafes;

        assets = [NATIVE_ASSET, address(w.token)];
        feedPrice = [int256(600e8), int256(1e8)];
        feedRound = [uint80(1), uint80(1)];

        for (uint256 i = 0; i < 4; ++i) {
            holders.push(w.players[i]);
        }
        holders.push(w.seedSafes[0]);
        holders.push(w.seedSafes[1]);
        holders.push(w.feeAccount);
        holders.push(w.keeper);
        holders.push(w.owner);
        holders.push(address(w.draw));
        holders.push(address(w.vault));

        _actionNames[A_DEPOSIT] = "deposit";
        _actionNames[A_WITHDRAW] = "withdraw";
        _actionNames[A_BUY] = "buy";
        _actionNames[A_BUY_LARGE] = "buyLarge";
        _actionNames[A_BUY_TARGET] = "buyToTarget";
        _actionNames[A_BUY_INVALID] = "buyInvalid";
        _actionNames[A_SEED] = "seedRound";
        _actionNames[A_WARP] = "warp";
        _actionNames[A_CLOSE] = "closeRound";
        _actionNames[A_ENSURE] = "ensureCurrent";
        _actionNames[A_REQUEST] = "requestDraw";
        _actionNames[A_FULFILL] = "fulfil";
        _actionNames[A_FULFILL_EDGE] = "fulfilEdge";
        _actionNames[A_EXPIRE] = "expireUnrequested";
        _actionNames[A_SETTLE] = "settle";
        _actionNames[A_CLAIM] = "claimRefund";
        _actionNames[A_PAUSE] = "pauseToggle";
        _actionNames[A_CONFIG] = "ownerConfig";
        _actionNames[A_PRICE] = "priceUpdate";
        _actionNames[A_COORD] = "coordinatorFault";
        _actionNames[A_DONATE] = "donate";
        _actionNames[A_DURESS] = "withdrawUnderDuress";
    }

    // ---------------------------------------------------------------------
    // Bootstrap (not counted as campaign actions)
    // ---------------------------------------------------------------------

    /// @notice Funds the actors, records the opening balances and snapshots the six rounds `addPool` created.
    function bootstrap() external {
        gPoolEnabled[1] = true;
        gPoolEnabled[2] = true;

        for (uint256 i = 0; i < 4; ++i) {
            _fundAndDeposit(players[i], 2_000 ether, 1_000_000_000);
        }
        _fundAndDeposit(seedSafes[0], 100 ether, 10_000_000);
        _fundAndDeposit(seedSafes[1], 100 ether, 10_000_000);

        // Two pools, seven sequences each: `addPool` opened fourteen rounds (ADR 036).
        _syncNewRounds(2 * KIND_COUNT);
        (uint8 p, string memory d) = checkGlobals();
        _recordIf(p, d);
    }

    function _fundAndDeposit(address who, uint256 nativeAmount, uint256 tokenAmount) private {
        vm.deal(who, who.balance + nativeAmount * 2);
        token.mint(who, tokenAmount * 2);
        vm.startPrank(who);
        token.approve(address(vault), type(uint256).max);
        vault.depositNative{value: nativeAmount}();
        vault.deposit(address(token), tokenAmount);
        vm.stopPrank();
        _gDeposit(who, assets[0], nativeAmount);
        _gDeposit(who, assets[1], tokenAmount);
    }

    // ---------------------------------------------------------------------
    // Vault money movements (SPEC §4.2)
    // ---------------------------------------------------------------------

    /// @notice Deposits native BNB or the 2-decimal token for one actor.
    function actDeposit(uint256 actorSeed, uint256 assetSeed, uint256 amountSeed) external {
        uint256 ai = _sub(assetSeed, 8) % 2;
        address asset = assets[ai];
        address who = _depositor(actorSeed);
        uint256 amount = ai == 0 ? _bound(amountSeed, 1e15, 50 ether) : _bound(amountSeed, 100, 5_000_000);

        if (vault.depositsPaused() || !vault.getAsset(asset).depositsEnabled) {
            _skip(A_DEPOSIT);
            return;
        }

        if (ai == 0) {
            vm.deal(who, who.balance + amount);
            vm.prank(who);
            try vault.depositNative{value: amount}() {
                _gDeposit(who, asset, amount);
                _applied(A_DEPOSIT, 0);
            } catch {
                _reverted(A_DEPOSIT);
            }
        } else {
            token.mint(who, amount);
            vm.prank(who);
            try vault.deposit(asset, amount) {
                _gDeposit(who, asset, amount);
                _applied(A_DEPOSIT, 0);
            } catch {
                _reverted(A_DEPOSIT);
            }
        }
    }

    /// @notice Withdraws part of an available balance to its own owner (the only outbound transfer, V4).
    function actWithdraw(uint256 actorSeed, uint256 assetSeed, uint256 amountSeed) external {
        uint256 ai = _sub(assetSeed, 8) % 2;
        address asset = assets[ai];
        address who = _depositor(actorSeed);
        uint256 balance = gBalance[who][asset];
        if (balance == 0) {
            _skip(A_WITHDRAW);
            return;
        }
        uint256 amount = _bound(amountSeed, 1, balance);

        vm.prank(who);
        try vault.withdraw(asset, amount) {
            _gWithdraw(who, asset, amount);
            _applied(A_WITHDRAW, 0);
        } catch {
            _reverted(A_WITHDRAW);
        }
    }

    /// @notice Donates assets straight into the Vault: a token transfer nobody credited, and forced BNB
    ///         (modelled with `vm.deal`, the only way to reach a contract with no `receive`). V1 must then
    ///         hold as `B == A + E + surplus`.
    function actDonate(uint256 assetSeed, uint256 amountSeed) external {
        uint256 ai = _sub(assetSeed, 8) % 2;
        uint256 amount = ai == 0 ? _bound(amountSeed, 1, 2 ether) : _bound(amountSeed, 1, 500_000);
        if (ai == 0) {
            vm.deal(address(vault), address(vault).balance + amount);
        } else {
            token.mint(address(vault), amount);
        }
        gDonated[assets[ai]] += amount;
        _applied(A_DONATE, 0);
    }

    // ---------------------------------------------------------------------
    // Entries (SPEC §5.3, §5.4)
    // ---------------------------------------------------------------------

    /// @notice A small player purchase, several of which are needed to approach a target.
    function actBuy(uint256 actorSeed, uint256 roundSeed, uint256 amountSeed) external {
        uint256 id = _pickBuyable(roundSeed);
        if (id == 0) {
            _skip(A_BUY);
            return;
        }
        uint256 amount = rg[id].asset == NATIVE_ASSET
            ? _bound(amountSeed, 2e15, 5e16)  // USD 1.2 .. USD 30
            : _bound(amountSeed, 100, 2_000); // USD 1 .. USD 20
        _buy(A_BUY, _player(actorSeed), id, amount);
    }

    /// @notice A large purchase, enough to carry a pot toward the weekly and monthly targets.
    function actBuyLarge(uint256 actorSeed, uint256 roundSeed, uint256 amountSeed) external {
        uint256 id = _pickBuyable(roundSeed);
        if (id == 0) {
            _skip(A_BUY_LARGE);
            return;
        }
        uint256 amount = rg[id].asset == NATIVE_ASSET
            ? _bound(amountSeed, 5e16, 20 ether)  // USD 30 .. USD 12,000
            : _bound(amountSeed, 2_000, 2_000_000); // USD 20 .. USD 20,000
        _buy(A_BUY_LARGE, _player(actorSeed), id, amount);
    }

    /// @notice Buys exactly the gross that lifts the pot onto its whole-USD target (D10 boundary).
    function actBuyToTarget(uint256 actorSeed, uint256 roundSeed) external {
        uint256 id = _pickBuyable(roundSeed);
        if (id == 0) {
            _skip(A_BUY_TARGET);
            return;
        }
        RoundGhost storage g = rg[id];
        uint256 index = g.asset == NATIVE_ASSET ? 0 : 1;
        if (feedMode[index] != 0) {
            _skip(A_BUY_TARGET);
            return;
        }
        uint256 price = uint256(feedPrice[index]);
        uint256 scale = 10 ** (uint256(g.tokenDecimals) + uint256(g.feedDecimals));
        uint256 needed = (uint256(g.targetUsd) * scale + price - 1) / price; // ceil, SPEC §3.2
        uint256 pending = g.seeded || !_seedOk(id) ? 0 : _seedAmountFor(id);
        uint256 have = g.grossTotal + pending;
        uint256 amount = needed > have ? needed - have : _minGross(g.tokenDecimals, g.feedDecimals, price);
        if (amount < _minGross(g.tokenDecimals, g.feedDecimals, price)) {
            amount = _minGross(g.tokenDecimals, g.feedDecimals, price);
        }
        _buy(A_BUY_TARGET, _player(actorSeed), id, amount);
    }

    /// @notice Deliberately inadmissible purchases: zero, below the USD 1 minimum, from the seed Safe, on a
    ///         round that is no longer Open, past the quote deadline and beyond the available balance.
    function actBuyInvalid(uint256 actorSeed, uint256 roundSeed, uint256 modeSeed) external {
        uint256 mode = _sub(modeSeed, 8) % 6;
        address who = _player(actorSeed);
        uint256 id = mode == 3 ? _pickClosed(roundSeed) : _pickBuyable(roundSeed);
        if (id == 0) {
            _skip(A_BUY_INVALID);
            return;
        }
        uint256 amount = 1e16;
        uint64 deadline = uint64(block.timestamp);
        if (mode == 0) amount = 0;
        if (mode == 1) amount = 1;
        if (mode == 2) who = seedSafes[0];
        if (mode == 4) deadline = uint64(block.timestamp - 1);
        if (mode == 5) amount = gBalance[who][rg[id].asset] + 1e18;
        if (rg[id].asset != NATIVE_ASSET && (mode == 0 || mode == 1)) amount = mode;

        // Every mode but the expired deadline (not a quote input) must already be rejected by the preview.
        if (mode != 4 && draw.quoteBuy(id, who, amount).reason == QuoteReason.None) {
            _record(P_QUOTE, _at(id, "quoteBuy approved an inadmissible purchase"));
        }

        vm.prank(who);
        try draw.buy(id, amount, 0, deadline) {
            _applied(A_BUY_INVALID, id);
            if (mode == 2) _record(P_V5, "a seed-authorised account bought through the player path");
            else if (mode == 3) _record(P_D5, "an entry was accepted after the round closed");
            else _record(P_D2, "an inadmissible purchase was accepted");
        } catch {
            _reverted(A_BUY_INVALID);
        }
    }

    /// @notice The keeper's own seeding cycle; also exercises the reverting entry point (SPEC §5.4).
    function actSeedRound(uint256 roundSeed) external {
        uint256 id = _pickUnseeded(roundSeed);
        if (id == 0) {
            if (_sub(roundSeed, 1) % 4 != 0) {
                _skip(A_SEED);
                return;
            }
            id = _pickOpen(roundSeed); // the reverting entry point: already seeded, or past the cutoff
        }
        if (id == 0) {
            _skip(A_SEED);
            return;
        }
        uint8 code = _seedCode(id);
        if (code != 0 && _sub(roundSeed, 2) % 3 != 0) {
            // The configuration currently forbids a seed; probe the reverting entry point now and then.
            _skip(A_SEED);
            return;
        }
        (address account, uint256 amount) = (draw.getSeedAccount(), _seedAmountFor(id));

        vm.prank(keeper);
        try draw.seedRound(id) {
            if (code != 0) _record(P_D9, "seedRound succeeded where the specification forbids a seed");
            _applySeedGhost(id, account, amount);
            _applied(A_SEED, id);
        } catch {
            if (code == 0) _record(P_D9, "seedRound rejected an admissible operator seed");
            seedSkips[code] += 1;
            _reverted(A_SEED);
        }
    }

    // ---------------------------------------------------------------------
    // Schedule and lifecycle (SPEC §6)
    // ---------------------------------------------------------------------

    /// @notice Advances time in bounded steps, from seconds to more than a month, so daily, weekly and
    ///         monthly cutoffs are all crossed, sometimes several at once.
    function actWarp(uint256 stepSeed) external {
        uint256 roll = _sub(stepSeed, 1) % 100;
        uint256 step;
        if (roll < 55) step = _bound(stepSeed, 1, 3600);
        else if (roll < 80) step = _bound(stepSeed, 3600, DAY);
        else if (roll < 95) step = _bound(stepSeed, DAY, 5 * DAY);
        else step = _bound(stepSeed, 5 * DAY, 20 * DAY); // a long keeper absence: several cutoffs at once

        vm.warp(block.timestamp + step);
        _republishHealthyFeeds();
        _applied(A_WARP, 0);
    }

    /// @notice Closes a round at or after its cutoff, choosing offsets that straddle the 24-hour request
    ///         window, and checks the branch the specification predicts (SPEC §6.2).
    function actCloseRound(uint256 roundSeed, uint256 offsetSeed) external {
        // A keeper closes what is already due before it waits for anything else, so the campaign follows the
        // calendar instead of jumping to a monthly cutoff and starving the daily sequences.
        uint256 id = _pickClosable(roundSeed);
        if (id == 0) {
            uint256 earliest = _earliestOpen();
            if (earliest == 0) {
                _skip(A_CLOSE);
                return;
            }
            if (_sub(offsetSeed, 1) % 8 == 0) {
                vm.prank(keeper);
                try draw.closeRound(earliest) {
                    _applied(A_CLOSE, earliest);
                    _record(P_D5, "closeRound succeeded before the cutoff");
                } catch {
                    _reverted(A_CLOSE);
                }
                return;
            }
            id = earliest;
            _warpTo(uint256(rg[id].closesAt) + _closeOffset(_sub(offsetSeed, 2)));
        }
        RoundGhost storage g = rg[id];

        State newState;
        RefundReason reason;
        if (g.grossTotal == 0 || g.grossTotal == g.seedGross) {
            newState = State.Void;
        } else if (g.playerCount == 1) {
            newState = State.Refunding;
            reason = RefundReason.InsufficientPlayers;
        } else if (block.timestamp < uint256(g.closesAt) + REQUEST_WINDOW) {
            newState = State.AwaitingRequest;
        } else {
            newState = State.Refunding;
            reason = RefundReason.RequestDeadlineExpired;
        }
        uint256 expectedNew = gPoolEnabled[g.poolId] ? 1 : 0;

        vm.prank(keeper);
        try draw.closeRound(id) {
            if (block.timestamp >= uint256(g.closesAt) + REQUEST_WINDOW) lateCloses += 1;
            _gClose(id, newState, CloseReason.Cutoff);
            g.refundReason = reason;
            if (newState == State.Void && g.seeded) {
                gRefunded[id][g.seedAccount] = true;
                g.refundedGross = g.seedGross;
                g.seedReturned = true;
                _gRelease(id, g.seedAccount, g.asset, g.seedGross);
            }
            _syncNewRounds(expectedNew);
            _applied(A_CLOSE, id);
        } catch {
            // The round is Open and at or past its cutoff, and `closeRound` reads no price and no coordinator,
            // so nothing the campaign can configure may reject it (SPEC §6.2, D7).
            _record(P_LIVE, _at(id, "closeRound reverted on an eligible past-cutoff Open round"));
            _reverted(A_CLOSE);
        }
    }

    /// @notice Re-points a pool/kind at a round, or creates the single successor when the pointer is zero.
    function actEnsureCurrent(uint256 poolSeed, uint256 kindSeed) external {
        uint256 poolId = 1 + (_sub(poolSeed, 8) % 2);
        Kind kind = Kind(_sub(kindSeed, 8) % KIND_COUNT);
        uint256 before = gCurrent[poolId][kind];

        if (!gPoolEnabled[poolId]) {
            if (_sub(poolSeed, 1) % 3 != 0) {
                _skip(A_ENSURE);
                return;
            }
            vm.prank(keeper);
            try draw.ensureCurrent(poolId, kind) {
                _applied(A_ENSURE, 0);
                _record(P_D4, "ensureCurrent created a round for a disabled pool");
            } catch {
                _reverted(A_ENSURE);
            }
            return;
        }

        uint256 expectedNew = before == 0 ? 1 : 0;
        vm.prank(keeper);
        try draw.ensureCurrent(poolId, kind) returns (uint256 id) {
            _syncNewRounds(expectedNew);
            if (before != 0 && id != before) _record(P_D4, "ensureCurrent moved an existing pointer");
            if (id != gCurrent[poolId][kind]) _record(P_D4, "ensureCurrent returned a round that is not current");
            _applied(A_ENSURE, id);
        } catch {
            _reverted(A_ENSURE);
        }
    }

    /// @notice Requests randomness for a closed round; fails while a coordinator fault is in force.
    function actRequestDraw(uint256 roundSeed) external {
        uint256 id = _pickRequestable(roundSeed);
        // Eligible only when the round is inside its window *and* the §6.2 pre-checks would pass: the campaign
        // deliberately deregisters the gas lane and drains the subscription, and a rejection then is correct.
        bool eligible = id != 0 && _coordinatorReady();
        if (id == 0) {
            // No round is inside its window: a quarter of the time still probe RequestWindowClosed.
            if (_sub(roundSeed, 1) % 4 != 0) {
                _skip(A_REQUEST);
                return;
            }
            id = _pickState(State.AwaitingRequest, roundSeed);
            if (id == 0) {
                _skip(A_REQUEST);
                return;
            }
        }
        uint256 expectedRequestId = coordinator.nextRequestId();

        vm.prank(keeper);
        try draw.requestDraw(id) {
            RoundGhost storage g = rg[id];
            if (block.timestamp >= uint256(g.closedAt) + REQUEST_WINDOW) {
                _record(P_D8, "a request was accepted at or after the deadline");
            }
            if (gByRequest[expectedRequestId] != 0) _record(P_D8, "byRequest is not injective");
            if (draw.getRound(id).requestId != expectedRequestId) {
                _record(P_D8, "the stored requestId is not the one the coordinator issued");
            }
            gByRequest[expectedRequestId] = id;
            gRequestIds.push(expectedRequestId);
            g.requestId = expectedRequestId;
            g.requestedAt = uint64(block.timestamp);
            g.state = State.Drawing;
            drawingRounds += 1;
            _applied(A_REQUEST, id);
        } catch {
            if (eligible) {
                _record(P_LIVE, _at(id, "requestDraw reverted on an eligible AwaitingRequest round"));
            }
            _reverted(A_REQUEST);
        }
    }

    /// @notice Ordinary two-word delivery through the mock coordinator, zero words included.
    function actFulfill(uint256 roundSeed, uint256 word0, uint256 word1) external {
        uint256 id = _pickDeliverable(roundSeed);
        if (id == 0) {
            _skip(A_FULFILL);
            return;
        }
        uint256[] memory words = new uint256[](2);
        if (word0 % 7 != 0) {
            words[0] = word0;
            words[1] = word1;
        } // otherwise both words stay zero: valid data (SPEC §7.1)

        delivered[rg[id].requestId] = true;
        try coordinator.fulfill(rg[id].requestId, words) returns (bool success) {
            if (!success) {
                _record(P_D5, "the authenticated callback reverted");
                _reverted(A_FULFILL);
                return;
            }
            RoundGhost storage g = rg[id];
            g.word0 = words[0];
            g.word1 = words[1];
            g.wordsStored = true;
            g.state = State.Ready;
            readyRounds += 1;
            _applied(A_FULFILL, id);
        } catch {
            _reverted(A_FULFILL);
        }
    }

    /// @notice Delivery edge cases: late (after the deadline), malformed, duplicate and unknown request.
    function actFulfillEdge(uint256 roundSeed, uint256 modeSeed) external {
        uint256 mode = _sub(modeSeed, 3) % 4;
        uint256[] memory two = new uint256[](2);
        two[0] = uint256(keccak256(abi.encode(modeSeed, "w0")));
        two[1] = uint256(keccak256(abi.encode(modeSeed, "w1")));

        if (mode == 0 || mode == 1) {
            uint256 id = _pickDeliverable(roundSeed);
            if (id == 0) {
                _skip(A_FULFILL_EDGE);
                return;
            }
            RoundGhost storage g = rg[id];
            if (delivered[g.requestId]) {
                _skip(A_FULFILL_EDGE);
                return;
            }
            if (mode == 0) {
                // Late but valid: an accepted request stays valid past its deadline (SPEC §6.2).
                _warpTo(uint256(g.closedAt) + REQUEST_WINDOW + 60);
                delivered[g.requestId] = true;
                try coordinator.fulfill(g.requestId, two) returns (bool success) {
                    if (!success) {
                        _record(P_D5, "a late authenticated callback reverted");
                        _reverted(A_FULFILL_EDGE);
                        return;
                    }
                    g.word0 = two[0];
                    g.word1 = two[1];
                    g.wordsStored = true;
                    g.state = State.Ready;
                    readyRounds += 1;
                    _applied(A_FULFILL_EDGE, id);
                } catch {
                    _reverted(A_FULFILL_EDGE);
                }
                return;
            }
            // Malformed: the coordinator records the delivery, the consumer ignores it and stays Drawing.
            uint256[] memory malformed = new uint256[](_sub(modeSeed, 1) % 2 == 0 ? 1 : 3);
            for (uint256 i = 0; i < malformed.length; ++i) {
                malformed[i] = two[0] + i;
            }
            delivered[g.requestId] = true;
            try coordinator.fulfill(g.requestId, malformed) {
                ignoredCallbacks += 1;
                _applied(A_FULFILL_EDGE, id);
            } catch {
                _reverted(A_FULFILL_EDGE);
            }
            return;
        }

        if (mode == 2) {
            // Duplicate: a second authenticated delivery for a request whose words are already stored.
            uint256 id = _pickState(State.Ready, roundSeed);
            if (id == 0) {
                _skip(A_FULFILL_EDGE);
                return;
            }
            vm.prank(address(coordinator));
            try draw.rawFulfillRandomWords(rg[id].requestId, two) {
                ignoredCallbacks += 1;
                _applied(A_FULFILL_EDGE, id);
            } catch {
                _reverted(A_FULFILL_EDGE);
            }
            return;
        }

        // Unknown: an authenticated delivery for a request this Draw never made.
        uint256 unknown = coordinator.nextRequestId() + 1_000_000 + (_sub(modeSeed, 2) % 97);
        vm.prank(address(coordinator));
        try draw.rawFulfillRandomWords(unknown, two) {
            if (draw.getRequest(unknown) != 0) _record(P_D8, "an unknown callback created a request mapping");
            ignoredCallbacks += 1;
            _applied(A_FULFILL_EDGE, 0);
        } catch {
            _reverted(A_FULFILL_EDGE);
        }
    }

    /// @notice Opens refunds for a round nobody requested inside its 24-hour window.
    function actExpireUnrequested(uint256 roundSeed, uint256 modeSeed) external {
        uint256 id = _pickExpirable(roundSeed);
        if (id == 0) id = _pickState(State.AwaitingRequest, roundSeed);
        if (id == 0) {
            _skip(A_EXPIRE);
            return;
        }
        RoundGhost storage g = rg[id];
        uint256 deadline = uint256(g.closedAt) + REQUEST_WINDOW;

        if (block.timestamp < deadline) {
            uint256 roll = _sub(modeSeed, 1) % 4;
            if (roll >= 2) {
                // The request window is still open: leave it to `requestDraw` most of the time.
                _skip(A_EXPIRE);
                return;
            }
            if (roll == 0) {
                vm.prank(keeper);
                try draw.expireUnrequested(id) {
                    _applied(A_EXPIRE, id);
                    _record(P_D8, "expireUnrequested succeeded before the deadline");
                } catch {
                    _reverted(A_EXPIRE);
                }
                return;
            }
            _warpTo(deadline + _bound(_sub(modeSeed, 2), 0, 3600));
        }

        vm.prank(keeper);
        try draw.expireUnrequested(id) {
            g.state = State.Refunding;
            g.refundReason = RefundReason.RequestDeadlineExpired;
            refundingRounds += 1;
            _applied(A_EXPIRE, id);
        } catch {
            // AwaitingRequest at or past `requestDeadline`: the only two guards §6.2 states are satisfied.
            _record(P_LIVE, _at(id, "expireUnrequested reverted on an eligible expired round"));
            _reverted(A_EXPIRE);
        }
    }

    /// @notice Settles a Ready round; the ghost picks the winner by its own scan before the call.
    function actSettle(uint256 roundSeed) external {
        uint256 id = _pickState(State.Ready, roundSeed);
        if (id == 0) {
            _skip(A_SETTLE);
            return;
        }
        RoundGhost storage g = rg[id];
        (address winner, uint256 index) = _ghostWinner(id);
        uint256 fee = _feeOf(g.grossTotal);
        uint256 prize = g.grossTotal - fee;

        vm.prank(keeper);
        try draw.settle(id) {
            g.settled = true;
            g.winner = winner;
            g.winningIndex = index;
            g.settledAt = uint64(block.timestamp);
            g.prizePaid = prize;
            g.feePaid = fee;
            g.state = State.Settled;
            settledRounds += 1;
            if (prize != 0) _gRelease(id, winner, g.asset, prize);
            if (fee != 0) _gRelease(id, g.feeAccount, g.asset, fee);
            _applied(A_SETTLE, id);
        } catch {
            // Ready is settle's only guard, and settlement reads nothing but frozen terms, the stored words and
            // the stored ranges, so it must succeed for any caller at any later time (SPEC §7.2, D7).
            _record(P_LIVE, _at(id, "settle reverted on an eligible Ready round"));
            _reverted(A_SETTLE);
        }
    }

    /// @notice Any caller credits any unrefunded buyer of a Refunding round; also exercises the two
    ///         reverting paths (no entry, already claimed).
    function actClaimRefund(uint256 roundSeed, uint256 actorSeed) external {
        uint256 id = _pickRefundable(roundSeed);
        if (id == 0) {
            // Nothing is owed: a third of the time still exercise AlreadyClaimed / no-entry, otherwise skip.
            if (_sub(roundSeed, 1) % 3 != 0) {
                _skip(A_CLAIM);
                return;
            }
            id = _pickState(State.Refunding, roundSeed);
        }
        if (id == 0) {
            _skip(A_CLAIM);
            return;
        }
        address caller = _player(actorSeed);
        address account = _unrefundedBuyer(id, actorSeed);

        if (account == address(0)) {
            address target = gBuyers[id].length == 0 ? keeper : (_sub(actorSeed, 5) % 2 == 0 ? keeper : gBuyers[id][0]);
            vm.prank(caller);
            try draw.claimRefund(id, target) {
                _applied(A_CLAIM, id);
                _record(P_D9, "claimRefund credited an account twice or one with no entry");
            } catch {
                _reverted(A_CLAIM);
            }
            return;
        }

        RoundGhost storage g = rg[id];
        uint256 gross = gGrossByUser[id][account];
        vm.prank(caller);
        try draw.claimRefund(id, account) {
            gRefunded[id][account] = true;
            g.refundedGross += gross;
            _gRelease(id, account, g.asset, gross);
            if (_unrefundedBuyer(id, 0) == address(0)) {
                fullyRefundedRounds += 1;
                if (g.refundedGross != g.grossTotal) {
                    _record(P_D3, _at(id, "eventual refunds do not add up to grossTotal"));
                }
            }
            _applied(A_CLAIM, id);
        } catch {
            // A Refunding round that still owes this buyer: D7 says the claim stays available at any later time.
            _record(P_LIVE, _at(id, "claimRefund reverted on an owed, unrefunded buyer of a Refunding round"));
            _reverted(A_CLAIM);
        }
    }

    // ---------------------------------------------------------------------
    // Owner configuration, prices and coordinator faults (SPEC §8.1, §3.2, §6.2)
    // ---------------------------------------------------------------------

    /// @notice Toggles the pauses that exist. None of them may move money (D6) or gate exits (V3).
    function actTogglePause(uint256 modeSeed) external {
        uint256 mode = _pauseMode(_sub(modeSeed, 1));
        // Independent of `mode`: `_bound` consumes the low bits, so reusing them would pin one flag on. A flag
        // that is already set is always cleared, so a pause window lasts until the next toggle of that flag
        // rather than for an unbounded stretch of the sequence.
        bool wants = _sub(modeSeed, 2) % 6 == 0;
        uint256 poolId = 1 + (_sub(modeSeed, 3) % 2);
        uint256 assetIndex = _sub(modeSeed, 4) % 2;
        (uint256 a0, uint256 a1, uint256 e0, uint256 e1) = _moneySnapshot();

        vm.startPrank(owner);
        if (mode == 0) {
            draw.setBuysPaused(draw.buysPaused() ? false : wants);
        } else if (mode == 1) {
            draw.setPoolBuysPaused(poolId, draw.getPool(poolId).buysPaused ? false : wants);
        } else if (mode == 2) {
            vault.setDepositsPaused(vault.depositsPaused() ? false : wants);
        } else {
            bool enabled = vault.getAsset(assets[assetIndex]).depositsEnabled;
            vault.setDepositsEnabled(assets[assetIndex], enabled ? !wants : true);
        }
        vm.stopPrank();

        _assertMoneyUnchanged(a0, a1, e0, e1, "a pause toggle moved money");
        _applied(A_PAUSE, 0);
    }

    /// @notice Owner configuration that is allowed to change future rounds only.
    function actOwnerConfig(uint256 modeSeed, uint256 valueSeed) external {
        uint256 mode = _sub(modeSeed, 8) % 5;
        uint256 poolId = 1 + (_sub(valueSeed, 1) % 2);
        (uint256 a0, uint256 a1, uint256 e0, uint256 e1) = _moneySnapshot();

        if (mode == 0) {
            uint256 index = poolId - 1;
            if (feeds[index].decimals() != FEED_DECIMALS) {
                _skip(A_CONFIG);
                return;
            }
            bool bounded = _sub(valueSeed, 2) % 2 == 0;
            PricingConfig memory cfg = PricingConfig({
                feed: address(feeds[index]),
                feedDecimals: FEED_DECIMALS,
                maxPriceAge: MAX_AGE,
                referenceKind: ReferenceKind.ExactToken,
                minAnswer: bounded ? int256(1e7) : int256(0),
                maxAnswer: bounded ? int256(1_000_000e8) : int256(0)
            });
            vm.prank(owner);
            try draw.setNextPricing(poolId, cfg) {
                _applied(A_CONFIG, 0);
            } catch {
                _reverted(A_CONFIG);
                return;
            }
        } else if (mode == 1) {
            uint32 target = uint32(_bound(_sub(valueSeed, 3), 10, 100_000));
            vm.prank(owner);
            try draw.setTargetUsd(poolId, Kind(_sub(valueSeed, 4) % KIND_COUNT), target) {
                _applied(A_CONFIG, 0);
            } catch {
                _reverted(A_CONFIG);
                return;
            }
        } else if (mode == 2) {
            uint256 roll = _sub(valueSeed, 5) % 10;
            uint256 amount = roll < 9 ? (poolId == 1 ? SEED_NATIVE : SEED_TOKEN) : (roll % 2 == 0 ? 0 : SEED_CAP * 2);
            vm.prank(owner);
            try draw.setSeedAmount(poolId, amount) {
                _applied(A_CONFIG, 0);
            } catch {
                _reverted(A_CONFIG);
                return;
            }
        } else if (mode == 3) {
            address account = seedSafes[_sub(valueSeed, 6) % 2];
            vm.prank(owner);
            try draw.setSeedAccount(account) {
                _applied(A_CONFIG, 0);
            } catch {
                _reverted(A_CONFIG);
                return;
            }
        } else {
            bool enabled = _sub(valueSeed, 7) % 6 != 0; // disabled a sixth of the time, restored later
            vm.prank(owner);
            try draw.setPoolEnabled(poolId, enabled) {
                gPoolEnabled[poolId] = enabled;
                _applied(A_CONFIG, 0);
            } catch {
                _reverted(A_CONFIG);
                return;
            }
        }

        _assertMoneyUnchanged(a0, a1, e0, e1, "an owner configuration change moved money");
    }

    /// @notice Republishes or degrades a price feed: fresh, stale, non-positive, future, changed decimals,
    ///         unreadable, and an answer clamped at a configured circuit-breaker bound.
    function actPriceUpdate(uint256 feedSeed, uint256 modeSeed) external {
        uint256 index = _sub(feedSeed, 8) % 2;
        MockAggregatorV3 f = feeds[index];
        uint256 mode = _sub(modeSeed, 9) % 24;
        feedRound[index] += 1;

        if (mode <= 17) {
            f.setRevert(false, false);
            f.setDecimals(FEED_DECIMALS);
            int256 base = index == 0 ? int256(600e8) : int256(1e8);
            feedPrice[index] = (base * int256(_bound(_sub(modeSeed, 1), 70, 130))) / 100;
            feedMode[index] = 0;
            f.set(feedRound[index], feedPrice[index], block.timestamp);
        } else if (mode == 18) {
            feedMode[index] = 1;
            f.set(feedRound[index], feedPrice[index], block.timestamp - MAX_AGE - 60);
        } else if (mode == 19) {
            feedMode[index] = 2;
            f.set(feedRound[index], 0, block.timestamp);
        } else if (mode == 20) {
            feedMode[index] = 3;
            f.set(feedRound[index], feedPrice[index], block.timestamp + 600);
        } else if (mode == 21) {
            feedMode[index] = 4;
            f.setDecimals(FEED_DECIMALS + 1);
        } else if (mode == 22) {
            feedMode[index] = 5;
            f.setRevert(true, false);
        } else {
            // At or below a configured minAnswer bound: not a market price (SPEC §3.1).
            feedMode[index] = 6;
            f.set(feedRound[index], int256(1e6), block.timestamp);
        }

        _applied(A_PRICE, 0);
    }

    /// @notice Deregisters the gas lane or drains the subscription, then restores them, so requests fail and
    ///         later succeed exactly as SPEC §6.2's pre-checks require.
    function actCoordinatorFault(uint256 modeSeed) external {
        uint256 mode = _sub(modeSeed, 8) % 8;
        if (mode <= 5) {
            coordinator.registerKey(draw.KEY_HASH(), 100 gwei);
            coordinator.fundNative(draw.SUBSCRIPTION_ID(), 10 ether);
        } else if (mode == 6) {
            coordinator.deregisterKey(draw.KEY_HASH());
        } else {
            coordinator.fundNative(draw.SUBSCRIPTION_ID(), 0);
        }
        _applied(A_COORD, 0);
    }

    /// @notice V3 probe: under every pause, a disabled pool and unreadable feeds, a holder must still be able
    ///         to withdraw the whole available balance. The probe runs against a state snapshot and is rolled
    ///         back, so the campaign continues from where it was.
    function actWithdrawUnderDuress(uint256 seed) external {
        (address who, address asset, uint256 balance) = _pickHolderWithBalance(seed);
        if (balance == 0) {
            _skip(A_DURESS);
            return;
        }
        // Counted before the snapshot so the record survives the rollback.
        _applied(A_DURESS, 0);
        v3Probes += 1;

        uint256 snapshot = vm.snapshotState();
        vm.startPrank(owner);
        draw.setBuysPaused(true);
        draw.setPoolBuysPaused(1, true);
        draw.setPoolBuysPaused(2, true);
        draw.setPoolEnabled(1, false);
        draw.setPoolEnabled(2, false);
        vault.setDepositsPaused(true);
        vault.setDepositsEnabled(assets[0], false);
        vault.setDepositsEnabled(assets[1], false);
        vm.stopPrank();
        feeds[0].setRevert(true, true);
        feeds[1].setRevert(true, true);

        uint256 before = _externalBalance(who, asset);
        bool ok;
        vm.prank(who);
        try vault.withdraw(asset, balance) {
            ok = _externalBalance(who, asset) == before + balance;
        } catch {
            ok = false;
        }
        vm.revertToState(snapshot);

        if (!ok) _record(P_V3, "an available withdrawal was gated by pause, price or round state");
    }

    // ---------------------------------------------------------------------
    // Internal: purchases
    // ---------------------------------------------------------------------

    /// @dev One admissible purchase. The quote is consulted first so that inadmissible input is skipped
    ///      rather than counted as a revert; the quote's own `reachesTarget` is then compared with what the
    ///      transaction actually did (SPEC §8.1, D10).
    function _buy(uint8 action, address who, uint256 id, uint256 amount) private {
        RoundGhost storage g = rg[id];
        if (gBalance[who][g.asset] < amount) {
            _skip(action);
            return;
        }
        ILuckyDraw.Quote memory quote = draw.quoteBuy(id, who, amount);
        if (quote.reason != QuoteReason.None) {
            quoteSkips[uint8(quote.reason)] += 1;
            _skip(action);
            return;
        }

        bool willSeed = !g.seeded && _seedOk(id);
        address seedAccount = draw.getSeedAccount();
        uint256 seedAmount = _seedAmountFor(id);
        uint256 price = uint256(quote.observation.answer);

        vm.prank(who);
        try draw.buy(id, amount, 0, uint64(block.timestamp)) {
            if (willSeed) {
                _applySeedGhost(id, seedAccount, seedAmount);
                fallbackSeeds += 1;
            }
            _gAppendEntry(id, who, amount);

            bool target = g.playerCount >= 2
                && _usd(g.grossTotal, g.tokenDecimals, g.feedDecimals, price) >= uint256(g.targetUsd);
            if (quote.reachesTarget != target) {
                _record(P_D10, _at(id, "quoteBuy reachesTarget disagreed with the executed purchase"));
            }

            uint256 expectedNew;
            if (target) {
                _gClose(id, State.AwaitingRequest, CloseReason.TargetReached);
                g.targetFromPlayerBuy = true;
                g.targetPrice = price;
                g.targetPriceUpdatedAt = quote.observation.updatedAt;
                g.targetPriceRoundId = quote.observation.roundId;
                if (gPoolEnabled[g.poolId]) expectedNew = 1;
            }
            _syncNewRounds(expectedNew);
            _applied(action, id);
        } catch {
            // The quote said None in this same block with the same balance and a deadline of now, so a revert
            // here is a preview/execution disagreement (SPEC §8.1), not a generated-input rejection.
            _record(P_QUOTE, _at(id, "quoteBuy reported None but buy reverted"));
            _reverted(action);
        }
    }

    /// @dev The operator seed as SPEC §5.4 describes it: a full second entry, then `Vault.lockSeed`.
    function _applySeedGhost(uint256 id, address account, uint256 amount) private {
        RoundGhost storage g = rg[id];
        g.seeded = true;
        g.seedAccount = account;
        g.seedGross = amount;
        g.seededAt = uint64(block.timestamp);
        g.seedCapAtSeed = vault.seedMaxPerRound(account, g.asset);
        _gAppendEntry(id, account, amount);
        seedEntries += 1;
    }

    /// @dev The seed classification of SPEC §5.4, recomputed from configuration rather than from the round:
    ///      0 admissible, 1 not configured, 2 not authorised, 3 already seeded, 4 not Open, 5 short balance,
    ///      6 buying paused. The seed is a new entry, so `seedRound` refuses it under either buy pause, which
    ///      it checks first; the fallback seed inside `buy` never sees code 6 because `buy` itself reverts.
    function _seedCode(uint256 id) private view returns (uint8) {
        address account = draw.getSeedAccount();
        uint256 amount = _seedAmountFor(id);
        RoundGhost storage g = rg[id];
        if (draw.buysPaused() || draw.getPool(g.poolId).buysPaused) return 6;
        if (amount == 0 || account == address(0)) return 1;
        if (vault.seedMaxPerRound(account, g.asset) < amount) return 2;
        if (g.seeded) return 3;
        if (g.state != State.Open || block.timestamp >= g.closesAt) return 4;
        if (vault.balanceOf(account, g.asset) < amount) return 5;
        return 0;
    }

    function _seedOk(uint256 id) private view returns (bool) {
        return _seedCode(id) == 0;
    }

    function _seedAmountFor(uint256 id) private view returns (uint256) {
        return draw.getPool(rg[id].poolId).seedAmount;
    }

    /// @dev The two SPEC §6.2 pre-checks `requestDraw` runs before it asks for randomness, recomputed from the
    ///      coordinator rather than from the Draw: the fixed gas lane is still registered and the subscription's
    ///      native balance covers every pending request plus this one. `actCoordinatorFault` breaks both on
    ///      purpose, so a rejection while either is false is correct behaviour, not a liveness failure (D7).
    function _coordinatorReady() private view returns (bool) {
        (bool exists,) = coordinator.s_provingKeys(draw.KEY_HASH());
        if (!exists) return false;
        (, uint96 nativeBalance,,,) = coordinator.getSubscription(draw.SUBSCRIPTION_ID());
        return uint256(nativeBalance) >= (draw.pendingRequests() + 1) * draw.MAX_REQUEST_COST_NATIVE();
    }

    // ---------------------------------------------------------------------
    // Internal: bookkeeping, selection and helpers
    // ---------------------------------------------------------------------

    /// @dev Verifies the round this action touched. The instant-wide ledger is checked by the invariant
    ///      functions themselves, which run after every generated call, applied or not.
    function _applied(uint8 action, uint256 roundId) private {
        appliedOf[action] += 1;
        totalApplied += 1;
        if (roundId != 0) {
            (uint8 p, string memory d) = checkRound(roundId);
            _recordIf(p, d);
        }
    }

    function _reverted(uint8 action) private {
        revertedOf[action] += 1;
        totalReverted += 1;
    }

    function _skip(uint8 action) private {
        skippedOf[action] += 1;
        totalSkipped += 1;
    }

    /// @dev Independent sub-seeds. The fuzzer's inputs cluster on small values and dictionary entries, so a
    ///      shift or a modulo of the raw seed collapses secondary choices onto a single branch; hashing does
    ///      not, which keeps pauses rare, buyers distinct and round selection spread across the sequence.
    function _sub(uint256 seed, uint256 salt) private pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, salt)));
    }

    function _player(uint256 seed) private view returns (address) {
        return players[_sub(seed, 11) % 4];
    }

    /// @dev Players plus both seed Safes: the seed account may hold and move a balance, it may only not buy.
    function _depositor(uint256 seed) private view returns (address) {
        uint256 index = _sub(seed, 12) % 6;
        return index < 4 ? players[index] : seedSafes[index - 4];
    }

    function _pickState(State want, uint256 seed) private view returns (uint256) {
        uint256 n = gRoundIds.length;
        if (n == 0) return 0;
        uint256 start = _sub(seed, 13) % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = gRoundIds[(start + i) % n];
            if (rg[id].state == want) return id;
        }
        return 0;
    }

    function _pickOpen(uint256 seed) private view returns (uint256) {
        return _pickState(State.Open, seed);
    }

    /// @dev An Open round still inside its entry window.
    function _pickBuyable(uint256 seed) private view returns (uint256) {
        uint256 n = gRoundIds.length;
        if (n == 0) return 0;
        uint256 start = _sub(seed, 13) % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = gRoundIds[(start + i) % n];
            RoundGhost storage g = rg[id];
            if (g.state == State.Open && block.timestamp < g.closesAt && block.timestamp >= g.opensAt) return id;
        }
        return 0;
    }

    /// @dev An Open round that is already at or past its cutoff, so `closeRound` needs no time travel.
    function _pickClosable(uint256 seed) private view returns (uint256) {
        uint256 n = gRoundIds.length;
        if (n == 0) return 0;
        uint256 start = _sub(seed, 13) % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = gRoundIds[(start + i) % n];
            RoundGhost storage g = rg[id];
            if (g.state == State.Open && block.timestamp >= g.closesAt) return id;
        }
        return 0;
    }

    /// @dev The Open round whose cutoff comes first: the next thing a keeper would have to do.
    function _earliestOpen() private view returns (uint256 earliest) {
        uint64 best = type(uint64).max;
        for (uint256 i = 0; i < gRoundIds.length; ++i) {
            uint256 id = gRoundIds[i];
            RoundGhost storage g = rg[id];
            if (g.state == State.Open && g.closesAt < best) {
                best = g.closesAt;
                earliest = id;
            }
        }
    }

    /// @dev An Open round inside its window that has not been seeded yet.
    function _pickUnseeded(uint256 seed) private view returns (uint256) {
        uint256 n = gRoundIds.length;
        if (n == 0) return 0;
        uint256 start = _sub(seed, 13) % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = gRoundIds[(start + i) % n];
            RoundGhost storage g = rg[id];
            if (g.state == State.Open && !g.seeded && block.timestamp < g.closesAt) return id;
        }
        return 0;
    }

    /// @dev A Drawing round whose request the coordinator has not delivered yet.
    function _pickDeliverable(uint256 seed) private view returns (uint256) {
        uint256 n = gRoundIds.length;
        if (n == 0) return 0;
        uint256 start = _sub(seed, 18) % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = gRoundIds[(start + i) % n];
            if (rg[id].state == State.Drawing && !delivered[rg[id].requestId]) return id;
        }
        return 0;
    }

    /// @dev An AwaitingRequest round still inside its 24-hour request window (SPEC §6.2).
    function _pickRequestable(uint256 seed) private view returns (uint256) {
        uint256 n = gRoundIds.length;
        if (n == 0) return 0;
        uint256 start = _sub(seed, 16) % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = gRoundIds[(start + i) % n];
            RoundGhost storage g = rg[id];
            if (g.state == State.AwaitingRequest && block.timestamp < uint256(g.closedAt) + REQUEST_WINDOW) {
                return id;
            }
        }
        return 0;
    }

    /// @dev An AwaitingRequest round whose request window has already run out.
    function _pickExpirable(uint256 seed) private view returns (uint256) {
        uint256 n = gRoundIds.length;
        if (n == 0) return 0;
        uint256 start = _sub(seed, 17) % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = gRoundIds[(start + i) % n];
            RoundGhost storage g = rg[id];
            if (g.state == State.AwaitingRequest && block.timestamp >= uint256(g.closedAt) + REQUEST_WINDOW) {
                return id;
            }
        }
        return 0;
    }

    /// @dev A Refunding round that still owes at least one buyer.
    function _pickRefundable(uint256 seed) private view returns (uint256) {
        uint256 n = gRoundIds.length;
        if (n == 0) return 0;
        uint256 start = _sub(seed, 13) % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = gRoundIds[(start + i) % n];
            if (rg[id].state == State.Refunding && _unrefundedBuyer(id, seed) != address(0)) return id;
        }
        return 0;
    }

    /// @dev Any round that is no longer Open, for the "entries stop at close" rejection.
    function _pickClosed(uint256 seed) private view returns (uint256) {
        uint256 n = gRoundIds.length;
        if (n == 0) return 0;
        uint256 start = _sub(seed, 13) % n;
        for (uint256 i = 0; i < n; ++i) {
            uint256 id = gRoundIds[(start + i) % n];
            if (rg[id].state != State.Open) return id;
        }
        return 0;
    }

    function _unrefundedBuyer(uint256 id, uint256 seed) private view returns (address) {
        address[] storage buyers = gBuyers[id];
        uint256 n = buyers.length;
        if (n == 0) return address(0);
        uint256 start = _sub(seed, 13) % n;
        for (uint256 i = 0; i < n; ++i) {
            address buyer = buyers[(start + i) % n];
            if (!gRefunded[id][buyer]) return buyer;
        }
        return address(0);
    }

    function _pickHolderWithBalance(uint256 seed) private view returns (address who, address asset, uint256 amount) {
        uint256 n = holders.length;
        uint256 start = _sub(seed, 14) % n;
        uint256 assetStart = _sub(seed, 15) % 2;
        for (uint256 i = 0; i < n; ++i) {
            who = holders[(start + i) % n];
            for (uint256 a = 0; a < 2; ++a) {
                asset = assets[(assetStart + a) % 2];
                amount = gBalance[who][asset];
                if (amount != 0) return (who, asset, amount);
            }
        }
        return (address(0), assets[0], 0);
    }

    /// @dev Which pause to toggle. The two entry stops are drawn less often than the deposit flags so that
    ///      the generated traffic spends most of its time able to buy.
    function _pauseMode(uint256 seed) private pure returns (uint256) {
        uint256 roll = _bound(seed, 0, 7);
        if (roll == 0) return 0; // global buys
        if (roll <= 2) return 1; // pool buys
        if (roll <= 4) return 2; // Vault deposits paused
        return 3; // Vault per-asset deposits enabled
    }

    /// @dev Offsets that straddle the 24-hour request window of SPEC §6.2.
    function _closeOffset(uint256 seed) private pure returns (uint256) {
        uint256 roll = seed % 10;
        if (roll <= 1) return 0;
        if (roll == 2) return 1;
        if (roll == 3) return 60;
        if (roll == 4) return 3600;
        if (roll == 5) return 43_200;
        if (roll == 6) return REQUEST_WINDOW - 1;
        if (roll == 7) return REQUEST_WINDOW; // exactly at the deadline: no request window left
        if (roll == 8) return REQUEST_WINDOW + 1;
        return 2 * REQUEST_WINDOW;
    }

    function _warpTo(uint256 when) private {
        if (when > block.timestamp) {
            vm.warp(when);
            _republishHealthyFeeds();
        }
    }

    /// @dev A healthy oracle keeps publishing across a time jump; a degraded one is left where it was, so a
    ///      stale or broken feed stays stale until the next explicit price action.
    function _republishHealthyFeeds() private {
        for (uint256 i = 0; i < 2; ++i) {
            if (feedMode[i] == 0) {
                feedRound[i] += 1;
                feeds[i].set(feedRound[i], feedPrice[i], block.timestamp);
            }
        }
    }

    function _moneySnapshot() private view returns (uint256, uint256, uint256, uint256) {
        return (
            vault.totalAvailable(assets[0]),
            vault.totalAvailable(assets[1]),
            vault.totalEscrow(assets[0]),
            vault.totalEscrow(assets[1])
        );
    }

    function _assertMoneyUnchanged(uint256 a0, uint256 a1, uint256 e0, uint256 e1, string memory detail) private {
        (uint256 b0, uint256 b1, uint256 f0, uint256 f1) = _moneySnapshot();
        if (a0 != b0 || a1 != b1 || e0 != f0 || e1 != f1) _record(P_D6, detail);
    }

    function _externalBalance(address who, address asset) private view returns (uint256) {
        return asset == NATIVE_ASSET ? who.balance : token.balanceOf(who);
    }

    // ---------------------------------------------------------------------
    // Campaign report (SPEC §11.2: per-action-type counts are part of the record)
    // ---------------------------------------------------------------------

    function actionName(uint8 action) external view returns (string memory) {
        return _actionNames[action];
    }

    /// @notice Prints applied/reverted/skipped counts per action type and the campaign's coverage markers.
    function report() external view {
        console2.log("--- LuckyDraw stateful campaign ---");
        console2.log("applied / reverted / skipped:", totalApplied, totalReverted, totalSkipped);
        if (totalApplied + totalReverted > 0) {
            console2.log("reverted per 10,000 calls:", (totalReverted * 10_000) / (totalApplied + totalReverted));
        }
        for (uint8 a = 0; a < A_COUNT; ++a) {
            console2.log(
                string.concat(
                    "  ",
                    _actionNames[a],
                    ": applied=",
                    vm.toString(appliedOf[a]),
                    " reverted=",
                    vm.toString(revertedOf[a]),
                    " skipped=",
                    vm.toString(skippedOf[a])
                )
            );
        }
        console2.log("rounds created:", gRoundIds.length, "requests accepted:", gRequestIds.length);
        console2.log("settled / void / refunding:", settledRounds, voidRounds, refundingRounds);
        console2.log("reached Drawing / reached Ready:", drawingRounds, readyRounds);
        console2.log("target closes / cutoff closes / late closes:", targetCloses, cutoffCloses, lateCloses);
        console2.log("seed entries / fallback seeds:", seedEntries, fallbackSeeds);
        console2.log("ignored callbacks / V3 probes:", ignoredCallbacks, v3Probes);
        console2.log("fully refunded rounds / violations:", fullyRefundedRounds, violationCount);
    }

    /// @notice One machine-summable line per invariant run; each run starts from the post-setUp state, so the
    ///         recorded campaign total is the sum of these lines.
    function reportCsv() external view {
        string memory totals = string.concat(
            "LDCSV_TOTALS,",
            vm.toString(totalApplied),
            ",",
            vm.toString(totalReverted),
            ",",
            vm.toString(totalSkipped),
            ",",
            vm.toString(gRoundIds.length),
            ",",
            vm.toString(gRequestIds.length),
            ",",
            vm.toString(settledRounds),
            ",",
            vm.toString(voidRounds),
            ",",
            vm.toString(refundingRounds)
        );
        console2.log(
            string.concat(
                totals,
                ",",
                vm.toString(targetCloses),
                ",",
                vm.toString(cutoffCloses),
                ",",
                vm.toString(lateCloses),
                ",",
                vm.toString(seedEntries),
                ",",
                vm.toString(fallbackSeeds),
                ",",
                vm.toString(ignoredCallbacks),
                ",",
                vm.toString(v3Probes),
                ",",
                vm.toString(fullyRefundedRounds),
                ",",
                vm.toString(violationCount)
            )
        );
        _csvRow("LDCSV_APPLIED", 0);
        _csvRow("LDCSV_REVERTED", 1);
        _csvRow("LDCSV_SKIPPED", 2);

        string memory quotes = "LDCSV_QUOTESKIPS";
        for (uint8 r = 0; r < 13; ++r) {
            quotes = string.concat(quotes, ",", vm.toString(quoteSkips[r]));
        }
        console2.log(quotes);

        string memory seeds = "LDCSV_SEEDSKIPS";
        for (uint8 r = 0; r < 7; ++r) {
            seeds = string.concat(seeds, ",", vm.toString(seedSkips[r]));
        }
        console2.log(seeds);

        // One column per property id, in P_ order, so a campaign record shows which property a failure hit.
        string memory props = "LDCSV_VIOLATIONS";
        for (uint8 p = 1; p < P_COUNT; ++p) {
            props = string.concat(props, ",", vm.toString(violations[p]));
        }
        console2.log(props);
    }

    function _csvRow(string memory label, uint8 which) private view {
        string memory line = label;
        for (uint8 a = 0; a < A_COUNT; ++a) {
            uint256 value = which == 0 ? appliedOf[a] : (which == 1 ? revertedOf[a] : skippedOf[a]);
            line = string.concat(line, ",", vm.toString(value));
        }
        console2.log(line);
    }
}
