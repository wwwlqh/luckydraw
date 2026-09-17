// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ILuckyDraw} from "./interfaces/ILuckyDraw.sol";
import {ILuckyVault} from "./interfaces/ILuckyVault.sol";
import {ImmutableVRFConsumer} from "./lib/ImmutableVRFConsumer.sol";
import {PriceReader} from "./lib/PriceReader.sol";
import {Schedule} from "./lib/Schedule.sol";
import {
    BPS,
    CallbackIgnoreReason,
    CloseReason,
    FEE_BPS,
    Kind,
    KIND_COUNT,
    Kinds,
    PricingConfig,
    QuoteReason,
    Range,
    RefundReason,
    REQUEST_WINDOW,
    ReleaseReason,
    SeedSkipReason,
    State
} from "./Types.sol";
import {
    AlreadyClaimed,
    AlreadyListed,
    AlreadySeeded,
    BelowMinimum,
    BuysPaused,
    DeadlineExpired,
    EntryWindowClosed,
    InsufficientSeedBalance,
    InvalidAmount,
    InvalidAsset,
    InvalidConfig,
    InvalidId,
    InvalidRecipient,
    InvalidRequestId,
    KeyHashUnsupported,
    NetContributionTooLow,
    PoolDisabled,
    PriceDecimalsChanged,
    PriceInvalid,
    PriceStale,
    PriceUnavailable,
    RequestWindowClosed,
    RequestWindowStillOpen,
    RoundNotClosed,
    SeedAccountCannotBuy,
    SeedNotAuthorized,
    SeedNotConfigured,
    SubscriptionUnderfunded,
    WrongState
} from "./Errors.sol";

/// @title LuckyDraw
/// @notice Pool configuration, frozen round terms, ownership ranges, fee arithmetic and the round lifecycle
///         (SPEC §5–§8). All custody lives in `LuckyVault`; this contract only instructs it.
/// @dev Design rules enforced here, each traceable to the specification:
///      - every mutation is `nonReentrant`, the authenticated VRF callback included (§4.2, §7.1);
///      - checks-effects-interactions: Draw state is written before any Vault or coordinator call;
///      - the owner has no path to money, prices, winners or randomness (§8.1, D6): there is no `setFee`,
///        no manual fulfilment, no forced winner, no coordinator setter and no arbitrary call;
///      - round terms (asset, decimals, pricing, feeAccount, targetUsd, opensAt, closesAt) are frozen at
///        creation and never change afterwards (D5);
///      - the only balance debited without a per-transaction signature is the operator seed account, only
///        through `ILuckyVault.lockSeed`, within the cap that account authorized itself (§5.4, D9);
///      - money paths never loop over holders: selection is a binary search, refunds are per account (§11.2).
contract LuckyDraw is ILuckyDraw, ImmutableVRFConsumer, Ownable2Step, ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @dev Pool record (SPEC §5.1). `asset` and `tokenDecimals` are frozen at `addPool`; the Vault's asset
    ///      record is itself immutable, so caching the decimals here cannot drift.
    struct Pool {
        uint256 id;
        address asset;
        uint8 tokenDecimals;
        bool enabled;
        bool buysPaused;
        PricingConfig nextPricing;
        uint256 seedAmount;
        uint32[KIND_COUNT] targetUsd;
    }

    /// @dev Round record (SPEC §5.1). Field order is chosen so that the small frozen and evolving fields
    ///      share slots; `ranges` and the two per-round mappings keep this struct storage-only.
    struct Round {
        uint256 id;
        uint256 poolId;
        uint256 sequence;
        address asset;
        uint8 tokenDecimals;
        Kind kind;
        State state;
        CloseReason closeReason;
        RefundReason refundReason;
        bool seeded;
        bool wordsStored;
        PricingConfig pricing;
        address feeAccount;
        uint64 opensAt;
        uint32 targetUsd;
        uint64 closesAt;
        uint64 closedAt;
        uint64 requestDeadline;
        uint64 requestedAt;
        address seedAccount;
        uint64 settledAt;
        address winner;
        uint256 grossTotal;
        uint256 feeReserved;
        uint256 prizePot;
        uint256 playerCount;
        uint256 seedGross;
        uint256 requestId;
        uint256 word0;
        uint256 word1;
        uint256 winningIndex;
        uint256 refundedGross;
        Range[] ranges;
        mapping(address user => uint256 gross) grossByUser;
        mapping(address user => bool claimed) refunded;
    }

    // ---------------------------------------------------------------------
    // Constants and immutables (SPEC §7.1: every VRF parameter is constructor-fixed)
    // ---------------------------------------------------------------------

    /// @notice Words requested per draw; two words expand one request into a 512-bit index (SPEC §7.2).
    uint32 public constant NUM_WORDS = 2;

    /// @notice Largest page a paginated view will return (SPEC §8.1).
    uint256 public constant MAX_PAGE = 100;

    /// @notice Smallest whole-USD round target the owner may configure (SPEC §8.1).
    uint32 public constant MIN_TARGET_USD = 10;

    /// @dev Per-kind default whole-USD targets live in `Kinds.defaultTargetUsd` (SPEC §6.1, ADR 036).

    /// @dev Seed attempt outcomes, shared by the skipping and the reverting entry points (SPEC §5.4).
    uint8 private constant SEED_OK = 0;
    uint8 private constant SEED_NOT_CONFIGURED = 1;
    uint8 private constant SEED_NOT_AUTHORIZED = 2;
    uint8 private constant SEED_ALREADY_SEEDED = 3;
    uint8 private constant SEED_NOT_OPEN = 4;
    uint8 private constant SEED_SHORT_BALANCE = 5;

    /// @notice The single Vault holding every asset this Draw plays with.
    ILuckyVault public immutable VAULT;

    /// @notice The operator VRF subscription billed in native BNB (SPEC §7.1).
    uint256 public immutable SUBSCRIPTION_ID;

    /// @notice The fixed gas lane; a deregistered lane blocks new requests (SPEC §6.2).
    bytes32 public immutable KEY_HASH;

    /// @notice Request confirmations, fixed at construction (SPEC §7.1 fixes 200).
    uint16 public immutable REQUEST_CONFIRMATIONS;

    /// @notice Callback budget, fixed at construction (SPEC §7.1 fixes 300,000).
    uint32 public immutable CALLBACK_GAS_LIMIT;

    /// @notice Worst-case native cost of one request, derived in SPEC §15 and fixed at construction.
    uint256 public immutable MAX_REQUEST_COST_NATIVE;

    // ---------------------------------------------------------------------
    // Storage (SPEC §5.1)
    // ---------------------------------------------------------------------

    /// @notice Number of pools; identifiers are 1..poolCount.
    uint256 public override poolCount;

    /// @notice Number of rounds ever created; identifiers are 1..roundCount.
    uint256 public override roundCount;

    /// @notice Accepted randomness requests without a valid callback (SPEC §6.2 funding pre-check).
    uint256 public override pendingRequests;

    /// @notice Fee recipient frozen into rounds opened from now on; live rounds keep their own (SPEC §8.1).
    address public override feeAccount;

    /// @notice Global new-entry stop. Never blocks exits, refunds or lifecycle calls (SPEC §8.1, V3).
    bool public override buysPaused;

    /// @dev The operator seed pointer; consent lives in the Vault's `authorizeSeed` (SPEC §5.4).
    address private _seedAccount;

    mapping(uint256 poolId => Pool pool) private _pools;
    mapping(uint256 roundId => Round round) private _rounds;
    mapping(uint256 poolId => mapping(Kind kind => uint256 roundId)) private _current;
    mapping(uint256 poolId => mapping(Kind kind => uint256 sequence)) private _lastSequence;
    mapping(uint256 requestId => uint256 roundId) private _byRequest;
    mapping(address asset => uint256 poolId) private _poolByAsset;

    /// @param vault_ The bound `LuckyVault`; must already have code.
    /// @param coordinator The immutable VRF v2.5 coordinator (SPEC §7.1).
    /// @param subscriptionId The operator subscription billed in native BNB.
    /// @param keyHash The fixed gas lane.
    /// @param requestConfirmations Request confirmations.
    /// @param callbackGasLimit Callback gas budget.
    /// @param maxRequestCostNative Worst-case native cost of one request, used by the funding pre-check.
    /// @param initialFeeAccount The operator treasury; nonzero and neither the Vault nor this contract.
    /// @param initialOwner The deploying operator address; ownership moves to the multisig in two steps.
    constructor(
        address vault_,
        address coordinator,
        uint256 subscriptionId,
        bytes32 keyHash,
        uint16 requestConfirmations,
        uint32 callbackGasLimit,
        uint256 maxRequestCostNative,
        address initialFeeAccount,
        address initialOwner
    ) ImmutableVRFConsumer(coordinator) Ownable(initialOwner) {
        if (vault_ == address(0) || vault_.code.length == 0) revert InvalidConfig();
        if (callbackGasLimit == 0 || maxRequestCostNative == 0) revert InvalidConfig();
        if (initialFeeAccount == address(0) || initialFeeAccount == vault_ || initialFeeAccount == address(this)) {
            revert InvalidRecipient();
        }

        VAULT = ILuckyVault(vault_);
        SUBSCRIPTION_ID = subscriptionId;
        KEY_HASH = keyHash;
        REQUEST_CONFIRMATIONS = requestConfirmations;
        CALLBACK_GAS_LIMIT = callbackGasLimit;
        MAX_REQUEST_COST_NATIVE = maxRequestCostNative;
        feeAccount = initialFeeAccount;
        emit FeeAccountSet(msg.sender, address(0), initialFeeAccount);
    }

    // ---------------------------------------------------------------------
    // Owner (SPEC §8.1)
    // ---------------------------------------------------------------------

    /// @notice Admits one listed asset as a pool and opens its seven first rounds.
    /// @dev Requires the Vault to be bound to this Draw, the asset to be listed and not already pooled, and a
    ///      valid pricing configuration. Each kind's target defaults to `Kinds.defaultTargetUsd` — USD 100 /
    ///      1,000 / 10,000 daily, 1,000 / 10,000 / 100,000 weekly and 100,000 monthly (SPEC §6.1, ADR 036) —
    ///      and seeding starts disabled (`seedAmount == 0`). No round is seeded at creation: the keeper calls
    ///      `seedRound` once the operator has configured a seed (SPEC §5.4).
    /// @param asset The listed asset, or `address(0)` for native BNB.
    /// @param pricing The pricing configuration the first seven rounds freeze.
    /// @return poolId The new pool identifier.
    function addPool(address asset, PricingConfig calldata pricing)
        external
        override
        nonReentrant
        onlyOwner
        returns (uint256 poolId)
    {
        if (VAULT.draw() != address(this)) revert WrongState();
        ILuckyVault.AssetRecord memory record = VAULT.getAsset(asset);
        if (!record.listed) revert InvalidAsset();
        if (_poolByAsset[asset] != 0) revert AlreadyListed();
        PriceReader.validateConfig(pricing);

        poolId = ++poolCount;
        Pool storage pool = _pools[poolId];
        pool.id = poolId;
        pool.asset = asset;
        pool.tokenDecimals = record.tokenDecimals;
        pool.enabled = true;
        pool.nextPricing = pricing;
        for (uint256 i = 0; i < KIND_COUNT; ++i) {
            pool.targetUsd[i] = Kinds.defaultTargetUsd(Kind(i));
        }
        _poolByAsset[asset] = poolId;

        emit PoolAdded(poolId, asset, msg.sender, record.tokenDecimals, pricing, 0, pool.targetUsd);

        for (uint256 i = 0; i < KIND_COUNT; ++i) {
            _current[poolId][Kind(i)] = _openRound(poolId, Kind(i));
        }
    }

    /// @notice Replaces the pricing configuration future rounds of this pool will freeze.
    /// @dev Validated on entry; rounds already open keep their frozen copy (D5). No caller-entered price.
    /// @param poolId The pool.
    /// @param pricing The new configuration.
    function setNextPricing(uint256 poolId, PricingConfig calldata pricing) external override nonReentrant onlyOwner {
        Pool storage pool = _requirePool(poolId);
        PriceReader.validateConfig(pricing);

        PricingConfig memory oldValue = pool.nextPricing;
        pool.nextPricing = pricing;
        emit NextPricingSet(poolId, msg.sender, oldValue, pricing);
    }

    /// @notice Points future rounds at a new fee recipient.
    /// @dev Rounds already open keep the account frozen at their creation, so live recipients never change.
    /// @param account The operator treasury; nonzero and neither the Vault nor this contract.
    function setFeeAccount(address account) external override nonReentrant onlyOwner {
        _requirePayable(account);
        address oldValue = feeAccount;
        feeAccount = account;
        emit FeeAccountSet(msg.sender, oldValue, account);
    }

    /// @notice Points the operator seed at an account.
    /// @dev A pointer only: the account must itself call `ILuckyVault.authorizeSeed` before any debit is
    ///      possible, and a round already seeded keeps the account that funded it (SPEC §5.4, D9).
    /// @param account The operator seed Safe; nonzero and neither the Vault nor this contract.
    function setSeedAccount(address account) external override nonReentrant onlyOwner {
        _requirePayable(account);
        address oldValue = _seedAccount;
        _seedAccount = account;
        emit SeedAccountSet(msg.sender, oldValue, account);
    }

    /// @notice Sets a pool's per-round operator seed in raw asset units.
    /// @dev Applies to seed entries made afterwards; 0 disables seeding for that pool. An amount above the
    ///      account's authorized cap simply produces `SeedSkipped(NotAuthorized)`.
    /// @param poolId The pool.
    /// @param amount The seed gross in raw units.
    function setSeedAmount(uint256 poolId, uint256 amount) external override nonReentrant onlyOwner {
        Pool storage pool = _requirePool(poolId);
        uint256 oldValue = pool.seedAmount;
        pool.seedAmount = amount;
        emit SeedAmountSet(poolId, msg.sender, oldValue, amount);
    }

    /// @notice Sets a pool's whole-USD target for one sequence kind.
    /// @dev At least `MIN_TARGET_USD`, applies to rounds created afterwards, and reads no feed: an oracle
    ///      outage must never block configuration (SPEC §8.1).
    /// @param poolId The pool.
    /// @param kind The sequence kind.
    /// @param targetUsd The new target in whole USD.
    function setTargetUsd(uint256 poolId, Kind kind, uint32 targetUsd) external override nonReentrant onlyOwner {
        Pool storage pool = _requirePool(poolId);
        if (targetUsd < MIN_TARGET_USD) revert InvalidConfig();

        uint32 oldValue = pool.targetUsd[uint256(kind)];
        pool.targetUsd[uint256(kind)] = targetUsd;
        emit TargetUsdSet(poolId, kind, msg.sender, oldValue, targetUsd);
    }

    /// @notice Enables or disables future round creation for a pool.
    /// @dev Existing rounds finish normally; re-enabling creates nothing implicitly (SPEC §6.1).
    /// @param poolId The pool.
    /// @param enabled The new enablement.
    function setPoolEnabled(uint256 poolId, bool enabled) external override nonReentrant onlyOwner {
        Pool storage pool = _requirePool(poolId);
        bool oldValue = pool.enabled;
        pool.enabled = enabled;
        emit PoolEnabledSet(poolId, msg.sender, oldValue, enabled);
    }

    /// @notice Stops or resumes new entries everywhere.
    /// @dev Never blocks withdrawal, close, request, expiry, settlement or refunds (SPEC §8.1, V3).
    /// @param paused The new global pause value.
    function setBuysPaused(bool paused) external override nonReentrant onlyOwner {
        bool oldValue = buysPaused;
        buysPaused = paused;
        emit BuysPausedSet(msg.sender, oldValue, paused);
    }

    /// @notice Stops or resumes new entries in one pool.
    /// @dev Never blocks withdrawal, close, request, expiry, settlement or refunds (SPEC §8.1, V3).
    /// @param poolId The pool.
    /// @param paused The new pool pause value.
    function setPoolBuysPaused(uint256 poolId, bool paused) external override nonReentrant onlyOwner {
        Pool storage pool = _requirePool(poolId);
        bool oldValue = pool.buysPaused;
        pool.buysPaused = paused;
        emit PoolBuysPausedSet(poolId, msg.sender, oldValue, paused);
    }

    /// @notice Starts a two-step ownership transfer; the zero address is rejected (SPEC §8.1).
    /// @param newOwner The address that must later call `acceptOwnership`.
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == address(0)) revert InvalidRecipient();
        super.transferOwnership(newOwner);
    }

    /// @notice Always reverts: the Draw must never become ownerless (SPEC §8.1, D6).
    function renounceOwnership() public pure override {
        revert InvalidRecipient();
    }

    // ---------------------------------------------------------------------
    // Entries (SPEC §5.3)
    // ---------------------------------------------------------------------

    /// @notice Enters a round with `grossAmount` raw units of its asset, fee reserve included.
    /// @dev Checks run in the precedence order of SPEC §5.1 so that `quoteBuy` can predict the first
    ///      failure: round exists, Open within its window, quote deadline, positive amount, pauses, a valid
    ///      price observation, then the USD 1 minimum. A round that already closed reverts
    ///      `EntryWindowClosed`, never `WrongState` (§5.3). If the round is still unseeded the operator seed
    ///      is attempted first (the fallback for a round the keeper has not seeded yet), so the seed's range
    ///      precedes this purchase. The fee is computed on cumulative
    ///      round gross, so splitting a total across buys or wallets cannot reduce it (§5.2). After the entry
    ///      is appended, a fresh reference value at or above the round's frozen target with at least two
    ///      distinct addresses closes the round as TargetReached and opens its successor in this same
    ///      transaction (§5.3, D10). No allowance to this contract is ever used: the Vault debits the
    ///      caller's available balance.
    /// @param roundId The round to enter.
    /// @param grossAmount Gross raw units to enter; at least the USD 1 minimum at the execution price.
    /// @param minNetContribution Smallest acceptable prize contribution, guarding fee-rounding movement.
    /// @param deadline Latest block timestamp at which this quote may execute.
    function buy(uint256 roundId, uint256 grossAmount, uint256 minNetContribution, uint64 deadline)
        external
        override
        nonReentrant
    {
        Round storage round = _requireRound(roundId);
        if (round.state != State.Open || block.timestamp < round.opensAt || block.timestamp >= round.closesAt) {
            revert EntryWindowClosed();
        }
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (grossAmount == 0) revert InvalidAmount();

        if (buysPaused || _pools[round.poolId].buysPaused) revert BuysPaused();

        PriceReader.Observation memory obs = _requirePrice(round, grossAmount);

        // Match Vault's player-path restriction before attempting a fallback seed or fee arithmetic.
        if (VAULT.seedMaxPerRound(msg.sender, round.asset) != 0) revert SeedAccountCannotBuy();

        // The operator seed enters before the first player purchase so that a lone player still draws (§5.4).
        if (!round.seeded) _trySeed(roundId);

        uint256 cumulativeGross;
        {
            (uint256 feeDelta, uint256 netDelta) = _feeSplit(round.grossTotal, round.feeReserved, grossAmount);
            if (netDelta < minNetContribution) revert NetContributionTooLow();

            cumulativeGross = _appendEntry(round, msg.sender, grossAmount);
            VAULT.lock(roundId, msg.sender, grossAmount);

            emit EntryBought(
                roundId,
                msg.sender,
                grossAmount,
                feeDelta,
                netDelta,
                cumulativeGross,
                obs.roundId,
                obs.answer,
                uint64(obs.updatedAt)
            );
        }

        if (
            round.playerCount >= 2
                && PriceReader.usdValue(
                        cumulativeGross, round.tokenDecimals, round.pricing.feedDecimals, uint256(obs.answer)
                    ) >= round.targetUsd
        ) {
            _close(round, State.AwaitingRequest, CloseReason.TargetReached);
            _advanceCurrent(round.poolId, round.kind);
        }
    }

    /// @dev Reads the round's frozen feed, turns a failing classification into the matching custom error and
    ///      enforces the USD 1 admission minimum at the execution price (SPEC §3.2). View-only.
    function _requirePrice(Round storage round, uint256 grossAmount)
        private
        view
        returns (PriceReader.Observation memory obs)
    {
        QuoteReason reason;
        (reason, obs) = PriceReader.read(round.pricing);
        if (reason != QuoteReason.None) _revertForPrice(reason);
        if (grossAmount < PriceReader.minGrossRaw(round.tokenDecimals, round.pricing.feedDecimals, uint256(obs.answer)))
        {
            revert BelowMinimum();
        }
    }

    /// @notice Enters the configured operator seed into a round, reverting instead of skipping.
    /// @dev Callable by anyone (SPEC §8.1): the amount, the account and the account's own Vault consent are
    ///      all operator configuration, so an external caller can only trigger what the operator already
    ///      authorized. The seed is exempt from the reference-price check and never triggers the target
    ///      close (§5.4, D10). It is a new entry, so it obeys the same global and pool buy pauses as `buy`:
    ///      during an incident freeze no caller can push the seed into an Open round. `buy`'s fallback seed
    ///      needs no separate check because `buy` already reverted `BuysPaused` before reaching it, and
    ///      `quoteBuy` reports `BuysPaused` before it models the seed, so the views stay consistent.
    /// @param roundId The Open round to seed.
    function seedRound(uint256 roundId) external override nonReentrant {
        Round storage round = _requireRound(roundId);
        if (buysPaused || _pools[round.poolId].buysPaused) revert BuysPaused();

        (uint8 code, address account, uint256 amount) = _seedStatus(round);

        if (code == SEED_NOT_CONFIGURED) revert SeedNotConfigured();
        if (code == SEED_NOT_AUTHORIZED) revert SeedNotAuthorized();
        if (code == SEED_ALREADY_SEEDED) revert AlreadySeeded();
        if (code == SEED_NOT_OPEN) revert EntryWindowClosed();
        if (code == SEED_SHORT_BALANCE) revert InsufficientSeedBalance();

        _applySeed(round, account, amount);
    }

    // ---------------------------------------------------------------------
    // Lifecycle (SPEC §6.2)
    // ---------------------------------------------------------------------

    /// @notice Closes an Open round at or after its cutoff and opens its successor.
    /// @dev Branches are disjoint and zero-entry handling takes precedence: no player entries close Void and
    ///      return the seed in the same transaction; a single player refunds as InsufficientPlayers; two or
    ///      more addresses reach AwaitingRequest while the 24-hour request window is still open, and
    ///      otherwise refund as RequestDeadlineExpired. Every branch sets `closedAt` once, records
    ///      `CloseReason.Cutoff`, closes the Vault escrow and advances `current` (D8). Needs no price and no
    ///      coordinator, so an oracle or VRF outage can never block it.
    /// @param roundId The round to close.
    function closeRound(uint256 roundId) external override nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.state != State.Open) revert WrongState();
        uint64 closesAt = round.closesAt;
        if (block.timestamp < closesAt) revert RoundNotClosed();

        uint256 grossTotal = round.grossTotal;
        uint256 seedGross = round.seedGross;

        State newState;
        RefundReason refundReason;
        bool refunding;
        if (grossTotal == 0 || grossTotal == seedGross) {
            newState = State.Void;
        } else if (round.playerCount == 1) {
            newState = State.Refunding;
            refundReason = RefundReason.InsufficientPlayers;
            refunding = true;
        } else if (block.timestamp < uint256(closesAt) + REQUEST_WINDOW) {
            newState = State.AwaitingRequest;
        } else {
            newState = State.Refunding;
            refundReason = RefundReason.RequestDeadlineExpired;
            refunding = true;
        }

        if (refunding) round.refundReason = refundReason;
        _close(round, newState, CloseReason.Cutoff);
        if (refunding) emit RoundRefunding(roundId, refundReason);

        // A round whose only entry is the operator seed returns it immediately, so empty rounds never enter
        // Refunding and never need a claim (SPEC §5.4, D9).
        if (newState == State.Void && round.seeded) {
            address seedAccount_ = round.seedAccount;
            round.refunded[seedAccount_] = true;
            round.refundedGross = seedGross;
            VAULT.release(roundId, seedAccount_, seedGross, ReleaseReason.Refund);
            emit Refunded(roundId, seedAccount_, seedGross);
        }

        _advanceCurrent(round.poolId, round.kind);
    }

    /// @notice Requests randomness for a closed round with at least two distinct addresses.
    /// @dev Refuses before it starts what the coordinator would never fulfil: the fixed key hash must still
    ///      be registered and the subscription's native balance must cover every pending request plus this
    ///      one, so an unfulfillable round expires into refunds instead of locking (SPEC §6.2). The round is
    ///      set to Drawing before the external request, and a zero or already-used request ID rolls the whole
    ///      transaction back, leaving AwaitingRequest for a later retry.
    /// @param roundId The AwaitingRequest round.
    function requestDraw(uint256 roundId) external override nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.state != State.AwaitingRequest) revert WrongState();
        if (block.timestamp >= round.requestDeadline) revert RequestWindowClosed();
        if (!_keyHashRegistered(KEY_HASH)) revert KeyHashUnsupported();
        if (_subscriptionNativeBalance(SUBSCRIPTION_ID) < (pendingRequests + 1) * MAX_REQUEST_COST_NATIVE) {
            revert SubscriptionUnderfunded();
        }

        round.state = State.Drawing;

        uint256 requestId =
            _requestRandomWords(KEY_HASH, SUBSCRIPTION_ID, REQUEST_CONFIRMATIONS, CALLBACK_GAS_LIMIT, NUM_WORDS);
        if (requestId == 0 || _byRequest[requestId] != 0) revert InvalidRequestId();

        _byRequest[requestId] = roundId;
        round.requestId = requestId;
        round.requestedAt = uint64(block.timestamp);
        pendingRequests += 1;

        emit DrawRequested(roundId, requestId, uint64(block.timestamp));
    }

    /// @notice Opens full refunds for a closed round that nobody requested before its deadline.
    /// @dev The round is already closed, so no successor work and no escrow call is needed here (SPEC §6.2).
    /// @param roundId The AwaitingRequest round at or past its `requestDeadline`.
    function expireUnrequested(uint256 roundId) external override nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.state != State.AwaitingRequest) revert WrongState();
        if (block.timestamp < round.requestDeadline) revert RequestWindowStillOpen();

        round.state = State.Refunding;
        round.refundReason = RefundReason.RequestDeadlineExpired;
        emit RoundRefunding(roundId, RefundReason.RequestDeadlineExpired);
    }

    /// @notice Determines the winner of a Ready round and releases the prize and the earned fee.
    /// @dev Reads only frozen terms, the stored words and the stored ranges, so the result is independent of
    ///      the caller, the timestamp, balances and any later price (SPEC §7.2). Outcome fields are written
    ///      before the Vault releases; a reverted attempt can be retried and cannot produce another result.
    /// @param roundId The Ready round.
    function settle(uint256 roundId) external override nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.state != State.Ready) revert WrongState();

        uint256 winningIndex = _winningIndexOf(round.word0, round.word1, round.grossTotal);
        address winner = _findRange(round.ranges, winningIndex);

        round.state = State.Settled;
        round.winner = winner;
        round.winningIndex = winningIndex;
        round.settledAt = uint64(block.timestamp);

        uint256 prize = round.prizePot;
        uint256 fee = round.feeReserved;
        address roundFeeAccount = round.feeAccount;
        if (prize != 0) VAULT.release(roundId, winner, prize, ReleaseReason.Prize);
        if (fee != 0) VAULT.release(roundId, roundFeeAccount, fee, ReleaseReason.Fee);

        emit RoundSettled(
            roundId, winner, round.requestId, winningIndex, prize, fee, roundFeeAccount, uint64(block.timestamp)
        );
    }

    /// @notice Credits one account's full gross entry back, fee included, in a Refunding round.
    /// @dev Callable by anyone for any buyer and credits only the named account, never the caller (D9). A
    ///      second claim reverts `AlreadyClaimed`; an account with no entry in this round reverts
    ///      `InvalidAmount` (the choice SPEC §8.1 leaves open: nothing is owed, rather than a bad recipient).
    ///      There is no claim deadline and no owner involvement.
    /// @param roundId The Refunding round.
    /// @param account The buyer to credit.
    function claimRefund(uint256 roundId, address account) external override nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.state != State.Refunding) revert WrongState();

        uint256 gross = round.grossByUser[account];
        if (gross == 0) revert InvalidAmount();
        if (round.refunded[account]) revert AlreadyClaimed();

        round.refunded[account] = true;
        round.refundedGross += gross;

        VAULT.release(roundId, account, gross, ReleaseReason.Refund);
        emit Refunded(roundId, account, gross);
    }

    /// @notice Returns the pool's current round for a kind, creating it when the pointer is zero.
    /// @dev Callable by anyone. A disabled pool reverts `PoolDisabled`; re-enabling never creates implicitly
    ///      (SPEC §6.1). Repeated calls return the same identifier, so successors cannot be duplicated (D4).
    /// @param poolId The pool.
    /// @param kind The sequence kind.
    /// @return roundId The current round identifier.
    function ensureCurrent(uint256 poolId, Kind kind) external override nonReentrant returns (uint256 roundId) {
        Pool storage pool = _requirePool(poolId);
        if (!pool.enabled) revert PoolDisabled();

        roundId = _current[poolId][kind];
        if (roundId != 0) return roundId;

        roundId = _openRound(poolId, kind);
        _current[poolId][kind] = roundId;
    }

    // ---------------------------------------------------------------------
    // Randomness callback (SPEC §7.1)
    // ---------------------------------------------------------------------

    /// @dev Authenticated by `ImmutableVRFConsumer.rawFulfillRandomWords`. Never reverts on unknown,
    ///      duplicate, wrong-state or malformed input: a revert here is recorded by the coordinator as a
    ///      failed fulfilment and is never retried (SPEC §7.3). Makes no external call at all, so the shared
    ///      reentrancy guard can never block an asynchronous delivery. Zero words are valid data.
    function _fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) internal override nonReentrant {
        uint256 roundId = _byRequest[requestId];
        if (roundId == 0) {
            emit CallbackIgnored(requestId, CallbackIgnoreReason.UnknownRequest);
            return;
        }

        Round storage round = _rounds[roundId];
        if (round.state != State.Drawing || round.wordsStored) {
            emit CallbackIgnored(requestId, CallbackIgnoreReason.DuplicateOrWrongState);
            return;
        }
        if (randomWords.length != NUM_WORDS) {
            emit CallbackIgnored(requestId, CallbackIgnoreReason.Malformed);
            return;
        }

        round.word0 = randomWords[0];
        round.word1 = randomWords[1];
        round.wordsStored = true;
        round.state = State.Ready;
        pendingRequests -= 1;

        emit RandomnessReceived(roundId, requestId, randomWords[0], randomWords[1]);
    }

    // ---------------------------------------------------------------------
    // Views (SPEC §8.1)
    // ---------------------------------------------------------------------

    /// @notice Returns a pool's configuration.
    /// @param poolId The pool.
    /// @return pool The pool view.
    function getPool(uint256 poolId) external view override returns (PoolView memory pool) {
        return _poolView(_requirePool(poolId));
    }

    /// @notice Returns a round's frozen terms and evolving state, with `rangeCount` instead of the ranges.
    /// @param roundId The round.
    /// @return round The fixed-size round view.
    function getRound(uint256 roundId) external view override returns (RoundView memory round) {
        Round storage stored = _requireRound(roundId);
        round.id = stored.id;
        round.poolId = stored.poolId;
        round.kind = stored.kind;
        round.sequence = stored.sequence;
        round.asset = stored.asset;
        round.tokenDecimals = stored.tokenDecimals;
        round.pricing = stored.pricing;
        round.feeAccount = stored.feeAccount;
        round.opensAt = stored.opensAt;
        round.closesAt = stored.closesAt;
        round.targetUsd = stored.targetUsd;
        round.state = stored.state;
        round.grossTotal = stored.grossTotal;
        round.feeReserved = stored.feeReserved;
        round.prizePot = stored.prizePot;
        round.playerCount = stored.playerCount;
        round.seeded = stored.seeded;
        round.seedAccount = stored.seedAccount;
        round.seedGross = stored.seedGross;
        round.closedAt = stored.closedAt;
        round.closeReason = stored.closeReason;
        round.requestDeadline = stored.requestDeadline;
        round.requestId = stored.requestId;
        round.requestedAt = stored.requestedAt;
        round.word0 = stored.word0;
        round.word1 = stored.word1;
        round.winningIndex = stored.winningIndex;
        round.winner = stored.winner;
        round.settledAt = stored.settledAt;
        round.refundedGross = stored.refundedGross;
        round.refundReason = stored.refundReason;
        round.rangeCount = stored.ranges.length;
    }

    /// @notice Returns one account's position in a round.
    /// @param roundId The round.
    /// @param user The account.
    /// @return gross The account's gross entered, seed included when it is the seed account.
    /// @return refunded Whether this round already credited that account's refund.
    /// @return shareNumerator The account's gross.
    /// @return shareDenominator The round's gross total; zero before any entry.
    function getPosition(uint256 roundId, address user)
        external
        view
        override
        returns (uint256 gross, bool refunded, uint256 shareNumerator, uint256 shareDenominator)
    {
        Round storage round = _requireRound(roundId);
        gross = round.grossByUser[user];
        refunded = round.refunded[user];
        shareNumerator = gross;
        shareDenominator = round.grossTotal;
    }

    /// @notice Returns the pool's current round for a kind, or zero when none is open.
    /// @param poolId The pool.
    /// @param kind The sequence kind.
    /// @return roundId The current round identifier, or zero.
    function getCurrent(uint256 poolId, Kind kind) external view override returns (uint256 roundId) {
        return _current[poolId][kind];
    }

    /// @notice Returns a page of pools ordered by identifier.
    /// @dev `cursor` is a zero-based offset; a cursor at or past the end returns an empty page (SPEC §8.1).
    /// @param cursor Zero-based offset into the pool list.
    /// @param limit Page size, 1 to 100.
    /// @return page The pools in this page.
    /// @return nextCursor The offset to pass for the following page.
    function getPools(uint256 cursor, uint256 limit)
        external
        view
        override
        returns (PoolView[] memory page, uint256 nextCursor)
    {
        uint256 total = poolCount;
        uint256 size = _pageSize(cursor, limit, total);
        page = new PoolView[](size);
        for (uint256 i = 0; i < size; ++i) {
            page[i] = _poolView(_pools[cursor + i + 1]);
        }
        nextCursor = cursor + size;
    }

    /// @notice Returns a page of a round's ownership ranges.
    /// @param roundId The round.
    /// @param cursor Zero-based offset into the range list.
    /// @param limit Page size, 1 to 100.
    /// @return page The ranges in this page.
    /// @return nextCursor The offset to pass for the following page.
    function getRanges(uint256 roundId, uint256 cursor, uint256 limit)
        external
        view
        override
        returns (Range[] memory page, uint256 nextCursor)
    {
        Round storage round = _requireRound(roundId);
        uint256 total = round.ranges.length;
        uint256 size = _pageSize(cursor, limit, total);
        page = new Range[](size);
        for (uint256 i = 0; i < size; ++i) {
            page[i] = round.ranges[cursor + i];
        }
        nextCursor = cursor + size;
    }

    /// @notice Maps an accepted coordinator request to its round.
    /// @param requestId The coordinator request ID.
    /// @return roundId The round, or zero for an unknown request.
    function getRequest(uint256 requestId) external view override returns (uint256 roundId) {
        return _byRequest[requestId];
    }

    /// @notice Returns the account the operator seed currently points at.
    /// @dev Pointing is not consent; the Vault's per-asset `seedMaxPerRound` is the authority (SPEC §5.4).
    /// @return account The seed pointer, or zero when unset.
    function getSeedAccount() external view override returns (address account) {
        return _seedAccount;
    }

    /// @notice Advisory preview of a purchase; never reverts for inadmissible input (SPEC §8.1, A32).
    /// @dev `reason` is the first failing check in `buy`'s order, with `InsufficientBalance` measured
    ///      against the Vault's available balance. The post-purchase figures include the operator seed that
    ///      `buy` would enter first, so the quoted `netDelta` matches what the purchase would actually add.
    /// @param roundId The round to preview.
    /// @param user The prospective buyer.
    /// @param grossAmount The gross raw units to preview.
    /// @return quote The preview.
    function quoteBuy(uint256 roundId, address user, uint256 grossAmount)
        external
        view
        override
        returns (Quote memory quote)
    {
        Round storage round = _rounds[roundId];
        if (round.id == 0) {
            quote.reason = QuoteReason.InvalidRound;
            return quote;
        }

        Pool storage pool = _pools[round.poolId];
        uint8 tokenDecimals = round.tokenDecimals;
        uint8 feedDecimals = round.pricing.feedDecimals;

        quote.closesAt = round.closesAt;
        quote.shareNumeratorBefore = round.grossByUser[user];
        quote.shareDenominatorBefore = round.grossTotal;

        (QuoteReason priceReason, PriceReader.Observation memory obs) = PriceReader.read(round.pricing);
        quote.observation = obs;
        uint256 price = priceReason == QuoteReason.None ? uint256(obs.answer) : 0;
        if (price != 0) quote.minGross = PriceReader.minGrossRaw(tokenDecimals, feedDecimals, price);

        if (round.state != State.Open || block.timestamp < round.opensAt || block.timestamp >= round.closesAt) {
            quote.reason = QuoteReason.EntryWindowClosed;
        } else if (grossAmount == 0) {
            quote.reason = QuoteReason.InvalidAmount;
        } else if (buysPaused || pool.buysPaused) {
            quote.reason = QuoteReason.BuysPaused;
        } else if (priceReason != QuoteReason.None) {
            quote.reason = priceReason;
        } else if (grossAmount < quote.minGross) {
            quote.reason = QuoteReason.BelowMinimum;
        } else if (VAULT.seedMaxPerRound(user, round.asset) != 0) {
            quote.reason = QuoteReason.SeedAccountCannotBuy;
        } else if (VAULT.balanceOf(user, round.asset) < grossAmount) {
            quote.reason = QuoteReason.InsufficientBalance;
        }

        // Rejected input must not reach projection arithmetic, even for a huge supplied amount.
        if (quote.reason != QuoteReason.None) return quote;
        if (grossAmount > type(uint256).max - round.grossTotal) {
            quote.reason = QuoteReason.ArithmeticOverflow;
            return quote;
        }

        // Model the seed `buy` would enter first, so the quoted split and target flag match execution.
        uint256 baseGross = round.grossTotal;
        uint256 baseFee = round.feeReserved;
        uint256 basePlayers = round.playerCount;
        if (!round.seeded) {
            (uint8 code, address seedAccount_, uint256 seedAmount) = _seedStatus(round);
            if (code == SEED_OK) {
                if (seedAmount > type(uint256).max - baseGross - grossAmount) {
                    quote.reason = QuoteReason.ArithmeticOverflow;
                    return quote;
                }
                baseGross += seedAmount;
                baseFee = Math.mulDiv(baseGross, FEE_BPS, BPS);
                if (round.grossByUser[seedAccount_] == 0) basePlayers += 1;
            }
        }

        uint256 postGross = baseGross + grossAmount;
        (bool beforeFits, uint256 usdBefore) =
            PriceReader.tryUsdValue(round.grossTotal, tokenDecimals, feedDecimals, price);
        (bool afterFits, uint256 usdAfter) = PriceReader.tryUsdValue(postGross, tokenDecimals, feedDecimals, price);
        if (!beforeFits || !afterFits) {
            quote.reason = QuoteReason.ArithmeticOverflow;
            return quote;
        }

        (quote.feeDelta, quote.netDelta) = _feeSplit(baseGross, baseFee, grossAmount);
        quote.shareNumeratorAfter = quote.shareNumeratorBefore + grossAmount;
        quote.shareDenominatorAfter = postGross;
        if (round.grossByUser[user] == 0) basePlayers += 1;
        quote.usdValueBefore = usdBefore;
        quote.usdValueAfter = usdAfter;
        quote.reachesTarget = basePlayers >= 2 && usdAfter >= round.targetUsd;
    }

    // ---------------------------------------------------------------------
    // Internal: rounds and seeding
    // ---------------------------------------------------------------------

    /// @dev Creates the next round of a pool/kind sequence with freshly frozen terms and registers its
    ///      escrow (SPEC §6.1). Creation deliberately does not attempt the operator seed: the keeper seeds a
    ///      new round with `seedRound` in its next cycle, and `buy` still seeds a round that is still
    ///      unseeded at its first player purchase, so no player ever faces an unseeded draw (SPEC §5.4).
    ///      Keeping the seed out of creation also keeps a closing or target-reaching transaction from paying
    ///      for an extra entry. The caller owns the `current` pointer.
    function _openRound(uint256 poolId, Kind kind) private returns (uint256 roundId) {
        Pool storage pool = _pools[poolId];

        roundId = ++roundCount;
        uint256 sequence = ++_lastSequence[poolId][kind];
        uint64 closesAt = Schedule.nextCutoff(block.timestamp, kind);
        address asset = pool.asset;
        address roundFeeAccount = feeAccount;
        uint32 targetUsd = pool.targetUsd[uint256(kind)];
        PricingConfig memory pricing = pool.nextPricing;

        Round storage round = _rounds[roundId];
        round.id = roundId;
        round.poolId = poolId;
        round.sequence = sequence;
        round.asset = asset;
        round.tokenDecimals = pool.tokenDecimals;
        round.kind = kind;
        round.pricing = pricing;
        round.feeAccount = roundFeeAccount;
        round.opensAt = uint64(block.timestamp);
        round.targetUsd = targetUsd;
        round.closesAt = closesAt;

        VAULT.registerRound(roundId, asset, closesAt);

        emit RoundOpened(
            roundId,
            poolId,
            kind,
            sequence,
            asset,
            pool.tokenDecimals,
            uint64(block.timestamp),
            closesAt,
            targetUsd,
            roundFeeAccount,
            pricing
        );
    }

    /// @dev Clears the pool/kind pointer and, while the pool is enabled, opens exactly one successor and
    ///      points at it (SPEC §6.1 "advance current"). Never reads a price and never calls the coordinator.
    function _advanceCurrent(uint256 poolId, Kind kind) private {
        _current[poolId][kind] = 0;
        if (_pools[poolId].enabled) {
            _current[poolId][kind] = _openRound(poolId, kind);
        }
    }

    /// @dev Writes the closing fields once, closes the Vault escrow and logs the close (SPEC §6.2, D8).
    function _close(Round storage round, State newState, CloseReason closeReason) private {
        uint64 closedAt = uint64(block.timestamp);
        round.state = newState;
        round.closedAt = closedAt;
        round.closeReason = closeReason;
        round.requestDeadline = closedAt + REQUEST_WINDOW;

        VAULT.closeEscrow(round.id);

        emit RoundClosed(
            round.id,
            newState,
            closeReason,
            closedAt,
            closedAt + REQUEST_WINDOW,
            round.grossTotal,
            round.prizePot,
            round.feeReserved,
            round.playerCount
        );
    }

    /// @dev Best-effort seed attempt, used only by `buy`'s fallback: logs `SeedSkipped` and returns instead
    ///      of reverting its caller, so a misconfigured or unfunded seed can never block a purchase (§5.4).
    function _trySeed(uint256 roundId) private {
        Round storage round = _rounds[roundId];
        (uint8 code, address account, uint256 amount) = _seedStatus(round);

        if (code == SEED_NOT_CONFIGURED) {
            emit SeedSkipped(roundId, SeedSkipReason.NotConfigured);
        } else if (code == SEED_NOT_AUTHORIZED) {
            emit SeedSkipped(roundId, SeedSkipReason.NotAuthorized);
        } else if (code == SEED_ALREADY_SEEDED || code == SEED_NOT_OPEN) {
            emit SeedSkipped(roundId, SeedSkipReason.NotOpen);
        } else if (code == SEED_SHORT_BALANCE) {
            emit SeedSkipped(roundId, SeedSkipReason.InsufficientSeedBalance);
        } else {
            _applySeed(round, account, amount);
        }
    }

    /// @dev Classifies a seed attempt in the order SPEC §5.4 states, shared by the skipping and reverting
    ///      entry points and by `quoteBuy`. Pure of side effects, so callers keep checks-effects-interactions.
    function _seedStatus(Round storage round) private view returns (uint8 code, address account, uint256 amount) {
        account = _seedAccount;
        amount = _pools[round.poolId].seedAmount;

        if (amount == 0 || account == address(0)) return (SEED_NOT_CONFIGURED, account, amount);
        if (VAULT.seedMaxPerRound(account, round.asset) < amount) return (SEED_NOT_AUTHORIZED, account, amount);
        if (round.seeded) return (SEED_ALREADY_SEEDED, account, amount);
        if (round.state != State.Open || block.timestamp >= round.closesAt) return (SEED_NOT_OPEN, account, amount);
        if (VAULT.balanceOf(account, round.asset) < amount) return (SEED_SHORT_BALANCE, account, amount);

        return (SEED_OK, account, amount);
    }

    /// @dev Applies an authorized seed exactly like a purchase, then debits it through `lockSeed` (SPEC §5.4).
    ///      The target check deliberately does not run: a seed entry never closes a round (D10).
    function _applySeed(Round storage round, address account, uint256 amount) private {
        uint256 roundId = round.id;
        (uint256 feeDelta, uint256 netDelta) = _feeSplit(round.grossTotal, round.feeReserved, amount);
        uint256 cumulativeGross = _appendEntry(round, account, amount);

        round.seeded = true;
        round.seedAccount = account;
        round.seedGross = amount;

        VAULT.lockSeed(roundId, account, amount);
        emit SeedEntered(roundId, account, amount, feeDelta, netDelta, cumulativeGross);
    }

    // ---------------------------------------------------------------------
    // Internal: entry arithmetic and selection
    // ---------------------------------------------------------------------

    /// @dev Appends one ownership range and updates the round's aggregates (SPEC §5.1, §5.2). `playerCount`
    ///      counts distinct addresses, so it only grows when this account had no gross yet.
    function _appendEntry(Round storage round, address buyer, uint256 gross) private returns (uint256 cumulativeGross) {
        cumulativeGross = round.grossTotal + gross;
        uint256 feeReserved = Math.mulDiv(cumulativeGross, FEE_BPS, BPS);

        round.grossTotal = cumulativeGross;
        round.feeReserved = feeReserved;
        round.prizePot = cumulativeGross - feeReserved;
        if (round.grossByUser[buyer] == 0) round.playerCount += 1;
        round.grossByUser[buyer] += gross;
        round.ranges.push(Range({buyer: buyer, cumulativeGross: cumulativeGross}));
    }

    /// @dev Fee split of one entry against cumulative round gross: `F(G+g) - F(G)` with `F` rounding down,
    ///      so splitting a total across buys or wallets cannot reduce the round's fee (SPEC §5.2).
    function _feeSplit(uint256 grossTotal, uint256 feeReserved, uint256 gross)
        internal
        pure
        returns (uint256 feeDelta, uint256 netDelta)
    {
        feeDelta = Math.mulDiv(grossTotal + gross, FEE_BPS, BPS) - feeReserved;
        netDelta = gross - feeDelta;
    }

    /// @dev `X mod W` for the 512-bit value formed by the two words, without constructing it (SPEC §7.2):
    ///      `b = 2^256 mod W`, then `i = (word0 * b + word1) mod W` using EVM `mulmod`/`addmod`.
    /// @param word0 The high word.
    /// @param word1 The low word.
    /// @param weight The round's gross total, strictly positive.
    /// @return The winning index in `[0, weight)`.
    function _winningIndexOf(uint256 word0, uint256 word1, uint256 weight) internal pure returns (uint256) {
        uint256 b = addmod(type(uint256).max % weight, 1, weight);
        return addmod(mulmod(word0, b, weight), word1, weight);
    }

    /// @dev Binary search for the first range whose `cumulativeGross` is strictly greater than `index`
    ///      (SPEC §5.1). Overflow-safe midpoint; O(log rangeCount) and no loop over holders.
    /// @param ranges The round's append-only ranges, strictly increasing in `cumulativeGross`.
    /// @param index The winning index, strictly below the last cumulative value.
    /// @return buyer The owner of the winning range.
    function _findRange(Range[] storage ranges, uint256 index) internal view returns (address buyer) {
        uint256 lo = 0;
        uint256 hi = ranges.length - 1;
        while (lo < hi) {
            uint256 mid = lo + (hi - lo) / 2;
            if (ranges[mid].cumulativeGross > index) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        return ranges[lo].buyer;
    }

    // ---------------------------------------------------------------------
    // Internal: shared guards and view helpers
    // ---------------------------------------------------------------------

    /// @dev Loads an existing pool or reverts `InvalidId`.
    function _requirePool(uint256 poolId) private view returns (Pool storage pool) {
        pool = _pools[poolId];
        if (pool.id == 0) revert InvalidId();
    }

    /// @dev Loads an existing round or reverts `InvalidId`.
    function _requireRound(uint256 roundId) private view returns (Round storage round) {
        round = _rounds[roundId];
        if (round.id == 0) revert InvalidId();
    }

    /// @dev Shared recipient policy for the fee and seed pointers (SPEC §8.1): never zero, the Vault or this
    ///      contract, all three of which would strand or recycle money.
    function _requirePayable(address account) private view {
        if (account == address(0) || account == address(VAULT) || account == address(this)) {
            revert InvalidRecipient();
        }
    }

    /// @dev Translates a failing price classification into the matching custom error (SPEC §3.2, §8.1).
    function _revertForPrice(QuoteReason reason) private pure {
        if (reason == QuoteReason.PriceUnavailable) revert PriceUnavailable();
        if (reason == QuoteReason.PriceInvalid) revert PriceInvalid();
        if (reason == QuoteReason.PriceStale) revert PriceStale();
        revert PriceDecimalsChanged();
    }

    /// @dev Validates a page request and returns how many items it yields (SPEC §8.1: limit 1-100, a cursor
    ///      at or past the end returns an empty page).
    function _pageSize(uint256 cursor, uint256 limit, uint256 total) private pure returns (uint256) {
        if (limit == 0 || limit > MAX_PAGE) revert InvalidAmount();
        if (cursor >= total) return 0;
        uint256 remaining = total - cursor;
        return remaining < limit ? remaining : limit;
    }

    /// @dev Copies a stored pool into its view struct.
    function _poolView(Pool storage pool) private view returns (PoolView memory view_) {
        view_.id = pool.id;
        view_.asset = pool.asset;
        view_.enabled = pool.enabled;
        view_.buysPaused = pool.buysPaused;
        view_.nextPricing = pool.nextPricing;
        view_.seedAmount = pool.seedAmount;
        view_.targetUsd = pool.targetUsd;
    }
}
