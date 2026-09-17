// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    CallbackIgnoreReason,
    CloseReason,
    Kind,
    KIND_COUNT,
    PricingConfig,
    QuoteReason,
    Range,
    RefundReason,
    SeedSkipReason,
    State
} from "../Types.sol";
import {PriceReader} from "../lib/PriceReader.sol";

/// @notice Pool configuration, frozen round terms, entry ranges, lifecycle and fee math (SPEC §5–§8).
/// @dev The Draw never transfers an external asset: every money movement is a `ILuckyVault` call. There is no
///      fee setter, no coordinator setter, no manual fulfilment, no forced winner and no arbitrary call
///      (SPEC §8.1, D6). Enum and struct member order is part of the ABI and of the generated client types.
interface ILuckyDraw {
    // ---------------------------------------------------------------------
    // View structs (SPEC §8.1: fixed size, no dynamic arrays in `getRound`)
    // ---------------------------------------------------------------------

    /// @notice A pool's current configuration.
    /// @param id Pool identifier; zero for an unknown pool.
    /// @param asset The immutable asset of every round in this pool.
    /// @param enabled Whether new rounds may be created.
    /// @param buysPaused Pool-level new-entry stop.
    /// @param nextPricing The pricing configuration the next round opened in this pool will freeze.
    /// @param seedAmount Operator seed per round in raw asset units; 0 disables seeding.
    /// @param targetUsd Whole-USD targets indexed by `Kind` (Day100, Day1k, Day10k, Week1k, Week10k,
    ///        Week100k, Month100k).
    struct PoolView {
        uint256 id;
        address asset;
        bool enabled;
        bool buysPaused;
        PricingConfig nextPricing;
        uint256 seedAmount;
        uint32[KIND_COUNT] targetUsd;
    }

    /// @notice A round's frozen terms and evolving state; `rangeCount` replaces the dynamic range array.
    struct RoundView {
        uint256 id;
        uint256 poolId;
        Kind kind;
        uint256 sequence;
        address asset;
        uint8 tokenDecimals;
        PricingConfig pricing;
        address feeAccount;
        uint64 opensAt;
        uint64 closesAt;
        uint32 targetUsd;
        State state;
        uint256 grossTotal;
        uint256 feeReserved;
        uint256 prizePot;
        uint256 playerCount;
        bool seeded;
        address seedAccount;
        uint256 seedGross;
        uint64 closedAt;
        CloseReason closeReason;
        uint64 requestDeadline;
        uint256 requestId;
        uint64 requestedAt;
        uint256 word0;
        uint256 word1;
        uint256 winningIndex;
        address winner;
        uint64 settledAt;
        uint256 refundedGross;
        RefundReason refundReason;
        uint256 rangeCount;
    }

    /// @notice Advisory purchase preview; `reason` is the first failing check in `buy`'s order (SPEC §5.1).
    /// @param reason QuoteReason.None when the purchase would be accepted.
    /// @param observation The feed observation; zeroed when the feed could not be read.
    /// @param minGross The USD 1 admission minimum in raw units; zero when no usable price exists.
    /// @param feeDelta Fee this purchase would add to the round's reserve.
    /// @param netDelta Prize contribution this purchase would add.
    /// @param shareNumeratorBefore The user's current gross in this round.
    /// @param shareDenominatorBefore The round's current gross total.
    /// @param shareNumeratorAfter The user's gross after this purchase.
    /// @param shareDenominatorAfter The round's gross total after this purchase, pending seed included.
    /// @param usdValueBefore Whole-USD reference value of the pot now.
    /// @param usdValueAfter Whole-USD reference value of the pot after this purchase.
    /// @param reachesTarget True when this purchase would close the round as TargetReached.
    /// @param closesAt The round's frozen cutoff.
    struct Quote {
        QuoteReason reason;
        PriceReader.Observation observation;
        uint256 minGross;
        uint256 feeDelta;
        uint256 netDelta;
        uint256 shareNumeratorBefore;
        uint256 shareDenominatorBefore;
        uint256 shareNumeratorAfter;
        uint256 shareDenominatorAfter;
        uint256 usdValueBefore;
        uint256 usdValueAfter;
        bool reachesTarget;
        uint64 closesAt;
    }

    // ---------------------------------------------------------------------
    // Events (SPEC §8.2)
    // ---------------------------------------------------------------------

    /// @notice A pool was admitted; its seven first rounds are opened in the same transaction.
    event PoolAdded(
        uint256 indexed poolId,
        address indexed asset,
        address actor,
        uint8 tokenDecimals,
        PricingConfig pricing,
        uint256 seedAmount,
        uint32[KIND_COUNT] targetUsd
    );

    /// @notice A round opened with the terms frozen for its whole life.
    /// @dev Every field SPEC §8.2 requires is present. The six pricing fields (feed, feedDecimals,
    ///      maxPriceAge, referenceKind, minAnswer, maxAnswer) travel inside the named `pricing` tuple rather
    ///      than flattened: none of them is an indexing field, and sixteen flat arguments cannot be encoded
    ///      by the legacy code generator this repository pins (`via_ir = false`) without assembly.
    event RoundOpened(
        uint256 indexed roundId,
        uint256 indexed poolId,
        Kind kind,
        uint256 sequence,
        address asset,
        uint8 tokenDecimals,
        uint64 opensAt,
        uint64 closesAt,
        uint32 targetUsd,
        address feeAccount,
        PricingConfig pricing
    );

    /// @notice A player purchase was accepted, with the feed observation that admitted it.
    event EntryBought(
        uint256 indexed roundId,
        address indexed buyer,
        uint256 gross,
        uint256 feeDelta,
        uint256 netDelta,
        uint256 cumulativeGross,
        uint80 oracleRoundId,
        int256 priceAnswer,
        uint64 priceUpdatedAt
    );

    /// @notice The operator seed entered a round (SPEC §5.4); excluded from player metrics (§9.8).
    event SeedEntered(
        uint256 indexed roundId,
        address indexed seedAccount,
        uint256 gross,
        uint256 feeDelta,
        uint256 netDelta,
        uint256 cumulativeGross
    );

    /// @notice A seed attempt did nothing; never reverts the enclosing creation or purchase.
    event SeedSkipped(uint256 indexed roundId, SeedSkipReason reason);

    /// @notice A round left Open; emitted by every closing branch including Void and Refunding.
    event RoundClosed(
        uint256 indexed roundId,
        State state,
        CloseReason closeReason,
        uint64 closedAt,
        uint64 requestDeadline,
        uint256 grossTotal,
        uint256 prizePot,
        uint256 feeReserved,
        uint256 playerCount
    );

    /// @notice The coordinator accepted a randomness request for this round.
    event DrawRequested(uint256 indexed roundId, uint256 indexed requestId, uint64 requestedAt);

    /// @notice An authenticated two-word delivery was stored; the round is Ready.
    event RandomnessReceived(uint256 indexed roundId, uint256 indexed requestId, uint256 word0, uint256 word1);

    /// @notice An authenticated delivery changed nothing: unknown, duplicate/wrong state, or malformed.
    event CallbackIgnored(uint256 indexed requestId, CallbackIgnoreReason reason);

    /// @notice The winner was determined and the prize and fee were released.
    event RoundSettled(
        uint256 indexed roundId,
        address indexed winner,
        uint256 indexed requestId,
        uint256 winningIndex,
        uint256 prize,
        uint256 fee,
        address feeAccount,
        uint64 settledAt
    );

    /// @notice The round became refundable; buyers claim their full gross once each.
    event RoundRefunding(uint256 indexed roundId, RefundReason reason);

    /// @notice One account's full gross was credited back, fee included.
    event Refunded(uint256 indexed roundId, address indexed user, uint256 gross);

    // ---- Configuration changes (SPEC §8.2: actor, old and new typed values) ----

    /// @notice The pricing configuration future rounds of this pool will freeze changed.
    event NextPricingSet(uint256 indexed poolId, address actor, PricingConfig oldValue, PricingConfig newValue);

    /// @notice The fee recipient future rounds will freeze changed; live rounds keep their own.
    event FeeAccountSet(address actor, address oldValue, address newValue);

    /// @notice The operator seed pointer changed; consent still lives in the Vault (SPEC §5.4).
    event SeedAccountSet(address actor, address oldValue, address newValue);

    /// @notice A pool's per-round seed size changed.
    event SeedAmountSet(uint256 indexed poolId, address actor, uint256 oldValue, uint256 newValue);

    /// @notice A pool's whole-USD target for one kind changed; rounds already open keep their own.
    event TargetUsdSet(uint256 indexed poolId, Kind kind, address actor, uint32 oldValue, uint32 newValue);

    /// @notice A pool's future-round creation was enabled or disabled.
    event PoolEnabledSet(uint256 indexed poolId, address actor, bool oldValue, bool newValue);

    /// @notice The global new-entry stop changed; exits and lifecycle calls are never affected.
    event BuysPausedSet(address actor, bool oldValue, bool newValue);

    /// @notice One pool's new-entry stop changed; exits and lifecycle calls are never affected.
    event PoolBuysPausedSet(uint256 indexed poolId, address actor, bool oldValue, bool newValue);

    // ---------------------------------------------------------------------
    // Public lifecycle (SPEC §5, §6, §8.1)
    // ---------------------------------------------------------------------

    function buy(uint256 roundId, uint256 grossAmount, uint256 minNetContribution, uint64 deadline) external;
    function seedRound(uint256 roundId) external;
    function closeRound(uint256 roundId) external;
    function requestDraw(uint256 roundId) external;
    function expireUnrequested(uint256 roundId) external;
    function settle(uint256 roundId) external;
    function claimRefund(uint256 roundId, address account) external;
    function ensureCurrent(uint256 poolId, Kind kind) external returns (uint256 roundId);

    // ---------------------------------------------------------------------
    // Owner (SPEC §8.1)
    // ---------------------------------------------------------------------

    function addPool(address asset, PricingConfig calldata pricing) external returns (uint256 poolId);
    function setNextPricing(uint256 poolId, PricingConfig calldata pricing) external;
    function setFeeAccount(address account) external;
    function setSeedAccount(address account) external;
    function setSeedAmount(uint256 poolId, uint256 amount) external;
    function setTargetUsd(uint256 poolId, Kind kind, uint32 targetUsd) external;
    function setPoolEnabled(uint256 poolId, bool enabled) external;
    function setBuysPaused(bool paused) external;
    function setPoolBuysPaused(uint256 poolId, bool paused) external;

    // ---------------------------------------------------------------------
    // Views (SPEC §8.1)
    // ---------------------------------------------------------------------

    function getPool(uint256 poolId) external view returns (PoolView memory pool);
    function getRound(uint256 roundId) external view returns (RoundView memory round);
    function getPosition(uint256 roundId, address user)
        external
        view
        returns (uint256 gross, bool refunded, uint256 shareNumerator, uint256 shareDenominator);
    function getCurrent(uint256 poolId, Kind kind) external view returns (uint256 roundId);
    function getPools(uint256 cursor, uint256 limit) external view returns (PoolView[] memory page, uint256 nextCursor);
    function getRanges(uint256 roundId, uint256 cursor, uint256 limit)
        external
        view
        returns (Range[] memory page, uint256 nextCursor);
    function getRequest(uint256 requestId) external view returns (uint256 roundId);
    function getSeedAccount() external view returns (address account);
    function quoteBuy(uint256 roundId, address user, uint256 grossAmount) external view returns (Quote memory quote);
    function feeAccount() external view returns (address);
    function buysPaused() external view returns (bool);
    function pendingRequests() external view returns (uint256);
    function poolCount() external view returns (uint256);
    function roundCount() external view returns (uint256);
}
