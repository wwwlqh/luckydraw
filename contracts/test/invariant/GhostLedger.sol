// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyVault} from "../../src/LuckyVault.sol";
import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {ILuckyVault} from "../../src/interfaces/ILuckyVault.sol";
import {
    CloseReason,
    Kind,
    KIND_COUNT,
    NATIVE_ASSET,
    Range,
    RefundReason,
    REQUEST_WINDOW,
    State
} from "../../src/Types.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @title GhostLedger
/// @notice Independent bookkeeping for the stateful invariant campaign (SPEC §11.2 "Stateful").
/// @dev The ledger never reads a production result to decide what *should* have happened: every expected
///      balance, escrow, fee, cutoff, winner and state transition below is recomputed from the specification
///      (§4.3 V1–V5, §5.2, §6.1, §6.2, §11.1 D1–D10) and only then compared with the contracts. Two rules keep
///      the campaign honest:
///      1. a ghost entry is written only after the corresponding call actually succeeded, so a reverted action
///         must leave every tracked number where it was;
///      2. a detected violation is *recorded*, never asserted, inside a handler action. With
///         `fail_on_revert = false` a reverting handler call is silently discarded by the fuzzer, which would
///         also discard the evidence; the invariant functions assert the recorded counters instead.
abstract contract GhostLedger is Test {
    // ---------------------------------------------------------------------
    // Property identifiers (one per SPEC property; used by the invariant functions)
    // ---------------------------------------------------------------------

    uint8 public constant P_V1 = 1;
    uint8 public constant P_V2 = 2;
    uint8 public constant P_V3 = 3;
    uint8 public constant P_V4 = 4;
    uint8 public constant P_V5 = 5;
    uint8 public constant P_D1 = 6;
    uint8 public constant P_D2 = 7;
    uint8 public constant P_D3 = 8;
    uint8 public constant P_D4 = 9;
    uint8 public constant P_D5 = 10;
    uint8 public constant P_D6 = 11;
    uint8 public constant P_D8 = 12;
    uint8 public constant P_D9 = 13;
    uint8 public constant P_D10 = 14;
    uint8 public constant P_QUOTE = 15;
    /// @dev D7 liveness evidence: a protocol call on a target the ghost deemed eligible reverted. Without it a
    ///      bug that permanently bricks `closeRound`, `settle` or `claimRefund` for a class of rounds would
    ///      only shrink the applied bucket and grow the reverted one, producing a zero-violation campaign.
    uint8 public constant P_LIVE = 16;
    uint8 public constant P_COUNT = 17;

    uint256 internal constant DAY = 86400;
    uint256 internal constant WEEK = 604800;
    uint256 internal constant WEEK_OFFSET = 259200;
    uint16 internal constant GHOST_FEE_BPS = 300;
    uint16 internal constant GHOST_BPS = 10000;

    // ---------------------------------------------------------------------
    // Wiring
    // ---------------------------------------------------------------------

    LuckyDraw internal draw;
    LuckyVault internal vault;
    MockERC20 internal token;

    address[2] internal assets; // [native, 2-decimal token]
    address[] internal holders; // every address that can ever hold a Vault balance

    // ---------------------------------------------------------------------
    // Violation record (asserted by the invariant functions, never thrown here)
    // ---------------------------------------------------------------------

    mapping(uint8 property => uint256 count) public violations;
    mapping(uint8 property => string detail) public firstViolation;
    uint256 public violationCount;

    // ---------------------------------------------------------------------
    // Ghost state
    // ---------------------------------------------------------------------

    /// @dev Everything the ledger believes about one round, recomputed from the specification.
    struct RoundGhost {
        bool known;
        // frozen terms, snapshotted the first time the round is seen
        uint256 poolId;
        Kind kind;
        uint256 sequence;
        address asset;
        uint8 tokenDecimals;
        uint8 feedDecimals;
        uint32 maxPriceAge;
        address feeAccount;
        uint64 opensAt;
        uint64 closesAt;
        uint32 targetUsd;
        bytes32 termsHash;
        // evolving game state
        State state;
        uint256 grossTotal;
        uint256 playerCount;
        uint256 rangeCount;
        uint256 escrow;
        // operator seed (SPEC §5.4, D9)
        bool seeded;
        address seedAccount;
        uint256 seedGross;
        uint64 seededAt;
        uint256 seedCapAtSeed;
        bool seedReturned;
        // closing (SPEC §6.2, D8)
        bool closed;
        uint64 closedAt;
        CloseReason closeReason;
        uint256 closeCount;
        uint256 grossAtClose;
        uint256 rangeCountAtClose;
        uint256 playerCountAtClose;
        // target close facts (D10)
        bool targetFromPlayerBuy;
        uint256 targetPrice;
        uint256 targetPriceUpdatedAt;
        uint80 targetPriceRoundId;
        // randomness (D5)
        uint256 requestId;
        uint64 requestedAt;
        bool wordsStored;
        uint256 word0;
        uint256 word1;
        // outcome
        bool settled;
        address winner;
        uint256 winningIndex;
        uint256 prizePaid;
        uint256 feePaid;
        uint64 settledAt;
        // refunds
        RefundReason refundReason;
        uint256 refundedGross;
    }

    mapping(uint256 roundId => RoundGhost) internal rg;
    mapping(uint256 roundId => Range[]) internal gRanges;
    mapping(uint256 roundId => mapping(address buyer => uint256 gross)) internal gGrossByUser;
    mapping(uint256 roundId => mapping(address buyer => bool claimed)) internal gRefunded;
    mapping(uint256 roundId => address[] buyers) internal gBuyers;
    uint256[] internal gRoundIds;

    mapping(uint256 poolId => mapping(Kind kind => uint256 roundId)) internal gCurrent;
    mapping(uint256 poolId => mapping(Kind kind => uint256 open)) internal gOpenCount;
    mapping(uint256 poolId => mapping(Kind kind => uint256 sequence)) internal gLastSequence;
    mapping(uint256 poolId => bool enabled) internal gPoolEnabled;
    mapping(uint256 requestId => uint256 roundId) internal gByRequest;
    uint256[] internal gRequestIds;

    // per-asset ledger (SPEC §4.3)
    mapping(address asset => uint256) internal gAvailable; // A
    mapping(address asset => uint256) internal gEscrowTotal; // E
    mapping(address asset => uint256) internal gDonated; // surplus: donations and forced BNB
    mapping(address asset => uint256) internal gDeposited; // cumulative inflow through deposit
    mapping(address asset => uint256) internal gWithdrawn; // cumulative outflow through withdraw
    mapping(address holder => mapping(address asset => uint256)) internal gBalance;

    // campaign observations used by the reports and by D3/D9/D10
    uint256 public v3Probes;
    uint256 public settledRounds;
    uint256 public voidRounds;
    uint256 public refundingRounds;
    uint256 public readyRounds;
    uint256 public drawingRounds;
    uint256 public targetCloses;
    uint256 public cutoffCloses;
    uint256 public lateCloses;
    uint256 public seedEntries;
    uint256 public fallbackSeeds;
    uint256 public ignoredCallbacks;
    uint256 public fullyRefundedRounds;

    // ---------------------------------------------------------------------
    // Violation recording
    // ---------------------------------------------------------------------

    /// @dev Records a violation without reverting; see the contract-level note on `fail_on_revert = false`.
    function _record(uint8 property, string memory detail) internal {
        violations[property] += 1;
        violationCount += 1;
        if (bytes(firstViolation[property]).length == 0) firstViolation[property] = detail;
    }

    /// @dev Records the (property, detail) pair returned by a view check when it is non-empty.
    function _recordIf(uint8 property, string memory detail) internal {
        if (property != 0) _record(property, detail);
    }

    function _at(uint256 roundId, string memory what) internal pure returns (string memory) {
        return string.concat("round ", vm.toString(roundId), ": ", what);
    }

    function _forAsset(address asset, string memory what) internal pure returns (string memory) {
        return string.concat(asset == NATIVE_ASSET ? "native: " : "token: ", what);
    }

    // ---------------------------------------------------------------------
    // Independent arithmetic (SPEC §5.2, §3.2, §6.1, §7.2)
    // ---------------------------------------------------------------------

    /// @dev floor(gross * 300 / 10000) written out, not the production mulDiv.
    function _feeOf(uint256 gross) internal pure returns (uint256) {
        return (gross * GHOST_FEE_BPS) / GHOST_BPS;
    }

    /// @dev floor(gross * price / 10^(d+f)); the campaign bounds amounts so the product always fits.
    function _usd(uint256 gross, uint8 tokenDecimals, uint8 feedDecimals, uint256 price)
        internal
        pure
        returns (uint256)
    {
        return (gross * price) / (10 ** (uint256(tokenDecimals) + uint256(feedDecimals)));
    }

    /// @dev ceil(10^(d+f) / price): the USD 1 admission minimum.
    function _minGross(uint8 tokenDecimals, uint8 feedDecimals, uint256 price) internal pure returns (uint256) {
        uint256 scale = 10 ** (uint256(tokenDecimals) + uint256(feedDecimals));
        return (scale + price - 1) / price;
    }

    /// @dev The next UTC cutoff, derived from a plain calendar walk rather than the production civil-date
    ///      algorithm, so D8's `closesAt == cutoff(opensAt, kind)` is a genuinely independent check.
    function _cutoff(uint256 t, Kind kind) internal pure returns (uint64) {
        if (kind == Kind.Day100 || kind == Kind.Day1k || kind == Kind.Day10k) {
            return uint64((t / DAY + 1) * DAY);
        }
        if (kind == Kind.Week1k || kind == Kind.Week10k || kind == Kind.Week100k) {
            return uint64(((t + WEEK_OFFSET) / WEEK + 1) * WEEK - WEEK_OFFSET);
        }

        uint256 day = t / DAY;
        uint256 y = 1970;
        while (true) {
            uint256 inYear = _isLeap(y) ? 366 : 365;
            if (day < inYear) break;
            day -= inYear;
            y += 1;
        }
        uint256 m = 1;
        while (true) {
            uint256 inMonth = _daysInMonth(y, m);
            if (day < inMonth) break;
            day -= inMonth;
            m += 1;
        }
        if (m == 12) {
            y += 1;
            m = 1;
        } else {
            m += 1;
        }
        return uint64(_daysBefore(y, m) * DAY);
    }

    function _isLeap(uint256 y) internal pure returns (bool) {
        return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    }

    function _daysInMonth(uint256 y, uint256 m) internal pure returns (uint256) {
        if (m == 2) return _isLeap(y) ? 29 : 28;
        if (m == 4 || m == 6 || m == 9 || m == 11) return 30;
        return 31;
    }

    /// @dev Days from 1970-01-01 to the first day of (y, m).
    function _daysBefore(uint256 y, uint256 m) internal pure returns (uint256 total) {
        for (uint256 yy = 1970; yy < y; ++yy) {
            total += _isLeap(yy) ? 366 : 365;
        }
        for (uint256 mm = 1; mm < m; ++mm) {
            total += _daysInMonth(y, mm);
        }
    }

    /// @dev `X mod W` for X = word0·2^256 + word1, then a linear scan of the ghost ranges. The production
    ///      contract uses the same reduction with a binary search; the scan is the independent part (§7.2).
    function _ghostWinner(uint256 roundId) internal view returns (address winner, uint256 index) {
        RoundGhost storage g = rg[roundId];
        uint256 w = g.grossTotal;
        uint256 twoPow256ModW = addmod(type(uint256).max % w, 1, w);
        index = addmod(mulmod(g.word0 % w, twoPow256ModW, w), g.word1 % w, w);

        Range[] storage ranges = gRanges[roundId];
        for (uint256 i = 0; i < ranges.length; ++i) {
            if (ranges[i].cumulativeGross > index) return (ranges[i].buyer, index);
        }
        return (address(0), index);
    }

    // ---------------------------------------------------------------------
    // Ledger mutation (called only after the matching call succeeded)
    // ---------------------------------------------------------------------

    function _gDeposit(address who, address asset, uint256 amount) internal {
        gBalance[who][asset] += amount;
        gAvailable[asset] += amount;
        gDeposited[asset] += amount;
    }

    function _gWithdraw(address who, address asset, uint256 amount) internal {
        gBalance[who][asset] -= amount;
        gAvailable[asset] -= amount;
        gWithdrawn[asset] += amount;
    }

    function _gLock(uint256 roundId, address who, address asset, uint256 amount) internal {
        gBalance[who][asset] -= amount;
        gAvailable[asset] -= amount;
        gEscrowTotal[asset] += amount;
        rg[roundId].escrow += amount;
    }

    function _gRelease(uint256 roundId, address who, address asset, uint256 amount) internal {
        gBalance[who][asset] += amount;
        gAvailable[asset] += amount;
        gEscrowTotal[asset] -= amount;
        rg[roundId].escrow -= amount;
    }

    /// @dev One accepted entry, player or seed: appends the range and updates the aggregates (SPEC §5.1).
    function _gAppendEntry(uint256 roundId, address buyer, uint256 gross) internal {
        RoundGhost storage g = rg[roundId];
        if (gGrossByUser[roundId][buyer] == 0) {
            g.playerCount += 1;
            gBuyers[roundId].push(buyer);
        }
        gGrossByUser[roundId][buyer] += gross;
        g.grossTotal += gross;
        g.rangeCount += 1;
        gRanges[roundId].push(Range({buyer: buyer, cumulativeGross: g.grossTotal}));
        _gLock(roundId, buyer, g.asset, gross);
    }

    /// @dev Closing fields common to every branch (SPEC §6.2: closedAt once, requestDeadline = closedAt+86400).
    function _gClose(uint256 roundId, State newState, CloseReason reason) internal {
        RoundGhost storage g = rg[roundId];
        g.state = newState;
        g.closed = true;
        g.closedAt = uint64(block.timestamp);
        g.closeReason = reason;
        g.closeCount += 1;
        g.grossAtClose = g.grossTotal;
        g.rangeCountAtClose = g.rangeCount;
        g.playerCountAtClose = g.playerCount;
        gCurrent[g.poolId][g.kind] = 0;
        gOpenCount[g.poolId][g.kind] -= 1;

        if (reason == CloseReason.TargetReached) targetCloses += 1;
        else cutoffCloses += 1;
        if (newState == State.Void) voidRounds += 1;
        if (newState == State.Refunding) refundingRounds += 1;
    }

    // ---------------------------------------------------------------------
    // Round discovery (SPEC §6.1 "advance current", D4, D8)
    // ---------------------------------------------------------------------

    /// @dev Snapshots every round the Draw created since the last sync and checks the creation-time rules.
    ///      `expectedNew` is what the specification says this action should have created: a close or an
    ///      `ensureCurrent` opens exactly one successor while the pool is enabled and none otherwise (D4).
    function _syncNewRounds(uint256 expectedNew) internal {
        uint256 chainCount = draw.roundCount();
        uint256 known = gRoundIds.length;
        if (chainCount < known) {
            _record(P_D4, "roundCount decreased");
            return;
        }
        uint256 created = chainCount - known;
        if (created != expectedNew) {
            _record(
                P_D4, string.concat("successors created=", vm.toString(created), " expected=", vm.toString(expectedNew))
            );
        }
        for (uint256 id = known + 1; id <= chainCount; ++id) {
            _snapshotRound(id);
        }
    }

    function _snapshotRound(uint256 id) internal {
        ILuckyDraw.RoundView memory r = draw.getRound(id);
        RoundGhost storage g = rg[id];

        g.known = true;
        g.poolId = r.poolId;
        g.kind = r.kind;
        g.sequence = r.sequence;
        g.asset = r.asset;
        g.tokenDecimals = r.tokenDecimals;
        g.feedDecimals = r.pricing.feedDecimals;
        g.maxPriceAge = r.pricing.maxPriceAge;
        g.feeAccount = r.feeAccount;
        g.opensAt = r.opensAt;
        g.closesAt = r.closesAt;
        g.targetUsd = r.targetUsd;
        g.termsHash = _termsHash(r);
        g.state = State.Open;
        gRoundIds.push(id);

        // D8: sequence = previous + 1 and the cutoff is the calendar cutoff of the opening time.
        if (r.sequence != gLastSequence[r.poolId][r.kind] + 1) _record(P_D8, _at(id, "sequence != previous + 1"));
        gLastSequence[r.poolId][r.kind] = r.sequence;
        if (r.closesAt != _cutoff(r.opensAt, r.kind)) _record(P_D8, _at(id, "closesAt != cutoff(opensAt, kind)"));
        if (r.opensAt != uint64(block.timestamp)) _record(P_D8, _at(id, "opensAt != creation time"));
        if (r.state != State.Open) _record(P_D4, _at(id, "new round is not Open"));
        if (r.grossTotal != 0 || r.rangeCount != 0 || r.playerCount != 0) {
            _record(P_D2, _at(id, "new round starts non-empty"));
        }

        // D4: the pointer for this pool/kind now names this round and nothing else is Open.
        uint256 previous = gCurrent[r.poolId][r.kind];
        if (previous != 0 && rg[previous].state == State.Open) {
            _record(P_D4, _at(id, "successor opened while the predecessor is still Open"));
        }
        gCurrent[r.poolId][r.kind] = id;
        gOpenCount[r.poolId][r.kind] += 1;
    }

    function _termsHash(ILuckyDraw.RoundView memory r) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                r.id,
                r.poolId,
                uint8(r.kind),
                r.sequence,
                r.asset,
                r.tokenDecimals,
                r.pricing,
                r.feeAccount,
                r.opensAt,
                r.closesAt,
                r.targetUsd
            )
        );
    }

    // ---------------------------------------------------------------------
    // Property checks: global (V1, V2, V4, D1, D4, D6)
    // ---------------------------------------------------------------------

    /// @notice Checks every instant-wide property; returns the first failing property and its description.
    function checkGlobals() public view returns (uint8 property, string memory detail) {
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            uint256 b = _custody(asset);
            uint256 a = vault.totalAvailable(asset);
            uint256 e = vault.totalEscrow(asset);

            // V2: the Vault's own totals equal the independently tracked A and E.
            if (a != gAvailable[asset]) return (P_V2, _forAsset(asset, "totalAvailable != ghost A"));
            if (e != gEscrowTotal[asset]) return (P_V2, _forAsset(asset, "totalEscrow != ghost E"));
            // V1: custody covers the ledger, with donated surplus accounted for explicitly.
            if (b != a + e + gDonated[asset]) return (P_V1, _forAsset(asset, "B != A + E + surplus"));
            if (b < a + e) return (P_V1, _forAsset(asset, "B < A + E"));
            // V4: the only external movements are deposits in and withdrawals out (plus donations).
            if (b + gWithdrawn[asset] != gDeposited[asset] + gDonated[asset]) {
                return (P_V4, _forAsset(asset, "custody moved outside deposit/withdraw/donation"));
            }
            // D1: the per-round escrows sum to the Vault's total for that asset.
            if (e != gEscrowTotal[asset]) return (P_D1, _forAsset(asset, "totalEscrow != sum of round escrows"));
        }

        // D4: at most one Open round per pool/kind and `current` is nonzero exactly when one exists.
        if (draw.roundCount() != gRoundIds.length) return (P_D4, "roundCount != ghost round count");
        for (uint256 p = 1; p <= 2; ++p) {
            for (uint256 k = 0; k < KIND_COUNT; ++k) {
                Kind kind = Kind(k);
                uint256 openCount = gOpenCount[p][kind];
                if (openCount > 1) return (P_D4, "more than one Open round for a pool/kind");
                uint256 current = draw.getCurrent(p, kind);
                if (current != gCurrent[p][kind]) return (P_D4, "current diverged from the ghost pointer");
                if ((current != 0) != (openCount == 1)) {
                    return (P_D4, "current is nonzero exactly when an Open round exists");
                }
                if (current != 0 && rg[current].state != State.Open) {
                    return (P_D4, "current names a round that is not Open");
                }
            }
        }

        // D6: the only account that can move internal money is the bound Draw, and it cannot be replaced.
        if (vault.draw() != address(draw)) return (P_D6, "Vault draw binding changed");
        if (address(draw.VAULT()) != address(vault)) return (P_D6, "Draw vault immutable changed");

        return (0, "");
    }

    /// @notice V2: every individual balance matches the ghost and the balances sum to `totalAvailable`.
    /// @dev Split out of `checkGlobals` because it is the one O(holders) global check; the invariant contract
    ///      runs it once per generated call.
    function checkBalances() public view returns (uint8, string memory) {
        for (uint256 i = 0; i < assets.length; ++i) {
            address asset = assets[i];
            uint256 summed;
            for (uint256 h = 0; h < holders.length; ++h) {
                uint256 onChain = vault.balanceOf(holders[h], asset);
                if (onChain != gBalance[holders[h]][asset]) {
                    return (P_V2, _forAsset(asset, "a holder balance diverged from the ghost"));
                }
                summed += onChain;
            }
            if (summed != vault.totalAvailable(asset)) return (P_V2, _forAsset(asset, "A != sum of user balances"));
        }
        return (0, "");
    }

    // ---------------------------------------------------------------------
    // Property checks: per round (V5, D1, D2, D3, D5, D8, D9, D10)
    // ---------------------------------------------------------------------

    /// @notice Checks every per-round property for one round; returns the first failing property.
    function checkRound(uint256 id) public view returns (uint8 property, string memory detail) {
        RoundGhost storage g = rg[id];
        if (!g.known) return (0, "");

        ILuckyDraw.RoundView memory r = draw.getRound(id);
        ILuckyVault.Escrow memory e = vault.getEscrow(id);

        // ---- D5: frozen terms never change ----
        if (_termsHash(r) != g.termsHash) return (P_D5, _at(id, "frozen terms changed"));
        if (r.state != g.state) return (P_D5, _at(id, "state is not the state the specification predicts"));

        // ---- D2: ranges, weights and player count ----
        if (r.grossTotal != g.grossTotal) return (P_D2, _at(id, "grossTotal != ghost gross"));
        if (r.rangeCount != g.rangeCount) return (P_D2, _at(id, "rangeCount != accepted entries"));
        if (r.playerCount != g.playerCount) return (P_D2, _at(id, "playerCount != distinct buyers"));
        if (r.playerCount != gBuyers[id].length) return (P_D2, _at(id, "playerCount != ghost buyer list"));

        uint256 summed;
        address[] storage buyers = gBuyers[id];
        for (uint256 i = 0; i < buyers.length; ++i) {
            address buyer = buyers[i];
            uint256 ghostGross = gGrossByUser[id][buyer];
            (uint256 gross, bool refunded,,) = draw.getPosition(id, buyer);
            if (gross != ghostGross) return (P_D2, _at(id, "grossByUser != ghost"));
            if (gross == 0) return (P_D2, _at(id, "a counted buyer has zero gross"));
            if (refunded != gRefunded[id][buyer]) return (P_D8, _at(id, "refunded flag != ghost"));
            summed += gross;

            // ---- V5: per-round Vault limits, independent of Draw ----
            uint256 locked = vault.lockedBy(id, buyer);
            if (locked != ghostGross) return (P_V5, _at(id, "Vault lockedBy != entered gross"));
            uint256 refundedTo = vault.refundedTo(id, buyer);
            if (refundedTo > locked) return (P_V5, _at(id, "refund exceeds what this account locked"));
            uint256 expectedRefunded = gRefunded[id][buyer] ? ghostGross : 0;
            if (refundedTo != expectedRefunded) return (P_V5, _at(id, "refundedTo != ghost refund"));
            if (buyer != g.seedAccount && vault.seedLocked(id, buyer) != 0) {
                return (P_V5, _at(id, "a player path debit was recorded as a seed debit"));
            }
        }
        if (summed != r.grossTotal) return (P_D2, _at(id, "sum of grossByUser != grossTotal"));

        (uint8 rangeProp, string memory rangeDetail) = _checkRanges(id, r.grossTotal);
        if (rangeProp != 0) return (rangeProp, rangeDetail);

        // ---- D3: fee and prize arithmetic ----
        uint256 expectedFee = _feeOf(g.grossTotal);
        if (r.feeReserved != expectedFee) return (P_D3, _at(id, "feeReserved != floor(gross * 3%)"));
        if (r.prizePot != g.grossTotal - expectedFee) return (P_D3, _at(id, "prizePot != gross - fee"));

        // ---- D1: escrow versus state ----
        uint256 expectedEscrow;
        if (
            r.state == State.Open || r.state == State.AwaitingRequest || r.state == State.Drawing
                || r.state == State.Ready
        ) {
            expectedEscrow = r.grossTotal;
        } else if (r.state == State.Refunding) {
            expectedEscrow = r.grossTotal - r.refundedGross;
        }
        if (e.amount != expectedEscrow) return (P_D1, _at(id, "escrow does not match the round state"));
        if (e.amount != g.escrow) return (P_D1, _at(id, "escrow != ghost escrow"));
        if (!e.registered) return (P_D1, _at(id, "round escrow is not registered"));
        if (e.asset != g.asset || e.closesAt != g.closesAt) return (P_D1, _at(id, "escrow terms changed"));
        if (e.closed != g.closed) return (P_V5, _at(id, "escrow closed flag != ghost close"));

        // ---- D8: bookkeeping ----
        if (g.closeCount > 1) return (P_D8, _at(id, "closedAt was set more than once"));
        if (g.closed) {
            if (r.closedAt != g.closedAt) return (P_D8, _at(id, "closedAt moved"));
            if (r.requestDeadline != uint64(uint256(g.closedAt) + REQUEST_WINDOW)) {
                return (P_D8, _at(id, "requestDeadline != closedAt + 86400"));
            }
            if (r.closeReason != g.closeReason) return (P_D8, _at(id, "closeReason changed"));
        } else if (r.closedAt != 0) {
            return (P_D8, _at(id, "closedAt set while still Open"));
        }
        if (r.refundedGross != g.refundedGross) return (P_D8, _at(id, "refundedGross != ghost"));
        uint256 refundSum;
        for (uint256 i = 0; i < buyers.length; ++i) {
            if (gRefunded[id][buyers[i]]) refundSum += gGrossByUser[id][buyers[i]];
        }
        if (refundSum != r.refundedGross) return (P_D8, _at(id, "refundedGross != sum of refunded buyers"));
        if (g.closesAt != _cutoff(g.opensAt, g.kind)) return (P_D8, _at(id, "closesAt != independent cutoff"));

        // ---- D5: immutability after the entry window and after acceptance ----
        if (g.closed && (r.grossTotal != g.grossAtClose || r.rangeCount != g.rangeCountAtClose)) {
            return (P_D5, _at(id, "an entry was accepted after the round closed"));
        }
        if (g.requestId != 0 && r.requestId != g.requestId) return (P_D5, _at(id, "accepted requestId overwritten"));
        if (g.requestId == 0 && r.requestId != 0) return (P_D5, _at(id, "requestId appeared without a request"));
        if (g.wordsStored && (r.word0 != g.word0 || r.word1 != g.word1)) {
            return (P_D5, _at(id, "stored randomness overwritten"));
        }
        if (!g.wordsStored && (r.word0 != 0 || r.word1 != 0)) {
            return (P_D5, _at(id, "randomness stored without an accepted callback"));
        }
        if (g.settled) {
            if (r.winner != g.winner || r.winningIndex != g.winningIndex || r.settledAt != g.settledAt) {
                return (P_D5, _at(id, "settled outcome changed"));
            }
            if (r.state != State.Settled) return (P_D5, _at(id, "a settled round left Settled"));
            // D3: on settlement the releases sum to grossTotal.
            if (g.prizePaid + g.feePaid != g.grossTotal) {
                return (P_D3, _at(id, "prize + fee released != grossTotal"));
            }
        } else if (r.winner != address(0)) {
            return (P_D5, _at(id, "winner set before settlement"));
        }

        // ---- D3: cancellation earns no fee and never over-refunds ----
        if (r.state == State.Refunding || r.state == State.Void) {
            if (g.feePaid != 0) return (P_D3, _at(id, "fee earned on a cancelled round"));
            if (g.refundedGross > g.grossTotal) return (P_D3, _at(id, "refunds exceed grossTotal"));
            if (r.state == State.Void && g.seeded && !g.seedReturned) {
                return (P_D9, _at(id, "Void round did not return the seed"));
            }
            if (r.state == State.Void && g.seeded && r.refundedGross != g.seedGross) {
                return (P_D9, _at(id, "Void round returned something other than seedGross"));
            }
        }

        // ---- D9: operator seed rules ----
        if (g.seeded) {
            if (r.seeded != true || r.seedAccount != g.seedAccount || r.seedGross != g.seedGross) {
                return (P_D9, _at(id, "seed record != ghost"));
            }
            if (g.seededAt >= g.closesAt) return (P_D9, _at(id, "seed entered at or after the cutoff"));
            if (g.seedGross > g.seedCapAtSeed) return (P_D9, _at(id, "seed exceeded the authorized cap"));
            if (vault.seedLocked(id, g.seedAccount) != g.seedGross) {
                return (P_D9, _at(id, "Vault seedLocked != seed gross"));
            }
            if (gGrossByUser[id][g.seedAccount] < g.seedGross) {
                return (P_D9, _at(id, "seed gross not credited to the seed account"));
            }
            if (g.grossTotal == g.seedGross && g.requestId != 0) {
                return (P_D9, _at(id, "a seed-only round requested randomness"));
            }
        } else {
            if (r.seeded || r.seedAccount != address(0) || r.seedGross != 0) {
                return (P_D9, _at(id, "seed recorded without a seed entry"));
            }
        }

        // ---- D10: target closes ----
        if (g.closed && g.closeReason == CloseReason.TargetReached) {
            if (!g.targetFromPlayerBuy) return (P_D10, _at(id, "target close outside a player purchase"));
            if (g.closedAt >= g.closesAt) return (P_D10, _at(id, "target close at or after the cutoff"));
            if (g.playerCountAtClose < 2) return (P_D10, _at(id, "target close with fewer than two addresses"));
            if (g.targetPrice == 0) return (P_D10, _at(id, "target close on a non-positive price"));
            if (g.targetPriceRoundId == 0) return (P_D10, _at(id, "target close on an invalid feed round"));
            if (g.targetPriceUpdatedAt > g.closedAt) return (P_D10, _at(id, "target close on a future price"));
            if (uint256(g.closedAt) - g.targetPriceUpdatedAt > g.maxPriceAge) {
                return (P_D10, _at(id, "target close on a stale price"));
            }
            if (_usd(g.grossAtClose, g.tokenDecimals, g.feedDecimals, g.targetPrice) < g.targetUsd) {
                return (P_D10, _at(id, "target close below the frozen target"));
            }
        }

        return (0, "");
    }

    /// @dev D2: stored ranges are strictly increasing, end at grossTotal and reproduce every buyer weight.
    function _checkRanges(uint256 id, uint256 grossTotal) private view returns (uint8, string memory) {
        uint256 count = gRanges[id].length;
        if (count == 0) {
            if (grossTotal != 0) return (P_D2, _at(id, "grossTotal without any range"));
            return (0, "");
        }
        // Every stored range is compared, a page of at most 100 at a time (the view's limit, SPEC §8.1).
        uint256 previous;
        uint256 seen;
        uint256 cursor;
        while (seen < count) {
            uint256 limit = count - seen > 100 ? 100 : count - seen;
            (Range[] memory page, uint256 next) = draw.getRanges(id, cursor, limit);
            if (page.length != limit) return (P_D2, _at(id, "getRanges returned a short page"));
            for (uint256 i = 0; i < page.length; ++i) {
                Range storage ghostRange = gRanges[id][seen + i];
                if (page[i].buyer != ghostRange.buyer) return (P_D2, _at(id, "range buyer != ghost"));
                if (page[i].cumulativeGross != ghostRange.cumulativeGross) {
                    return (P_D2, _at(id, "range cumulativeGross != ghost"));
                }
                if (page[i].cumulativeGross <= previous) {
                    return (P_D2, _at(id, "ranges are not strictly increasing"));
                }
                previous = page[i].cumulativeGross;
            }
            seen += page.length;
            cursor = next;
        }
        if (previous != grossTotal) return (P_D2, _at(id, "last range does not end at grossTotal"));
        return (0, "");
    }

    // ---------------------------------------------------------------------
    // Views used by the invariant contract
    // ---------------------------------------------------------------------

    function ghostRoundCount() external view returns (uint256) {
        return gRoundIds.length;
    }

    /// @notice The pool/kind pointer the specification says should be current.
    function ghostCurrent(uint256 poolId, Kind kind) external view returns (uint256) {
        return gCurrent[poolId][kind];
    }

    /// @notice How many rounds of this pool/kind the ledger believes are Open (D4 allows at most one).
    function ghostOpenCount(uint256 poolId, Kind kind) external view returns (uint256) {
        return gOpenCount[poolId][kind];
    }

    function availableOf(address asset) external view returns (uint256) {
        return gAvailable[asset];
    }

    function escrowTotalOf(address asset) external view returns (uint256) {
        return gEscrowTotal[asset];
    }

    function surplusOf(address asset) external view returns (uint256) {
        return gDonated[asset];
    }

    function depositedOf(address asset) external view returns (uint256) {
        return gDeposited[asset];
    }

    function withdrawnOf(address asset) external view returns (uint256) {
        return gWithdrawn[asset];
    }

    function custodyOf(address asset) external view returns (uint256) {
        return _custody(asset);
    }

    function ghostRoundAt(uint256 index) external view returns (uint256) {
        return gRoundIds[index];
    }

    function ghostRequestCount() external view returns (uint256) {
        return gRequestIds.length;
    }

    /// @notice D8: `byRequest` is injective and every accepted request maps back to its round.
    function checkRequests() external view returns (uint8, string memory) {
        for (uint256 i = 0; i < gRequestIds.length; ++i) {
            uint256 requestId = gRequestIds[i];
            uint256 roundId = gByRequest[requestId];
            if (draw.getRequest(requestId) != roundId) return (P_D8, "byRequest lost an accepted request");
            if (rg[roundId].requestId != requestId) return (P_D8, "round does not own its request id");
            for (uint256 j = i + 1; j < gRequestIds.length; ++j) {
                if (gRequestIds[j] == requestId) return (P_D8, "byRequest is not injective");
            }
        }
        return (0, "");
    }

    function _custody(address asset) internal view returns (uint256) {
        return asset == NATIVE_ASSET ? address(vault).balance : token.balanceOf(address(vault));
    }
}
