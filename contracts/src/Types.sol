// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {InvalidKind} from "./Errors.sol";

/// @notice Shared enums, structs and constants (SPEC §3.1, §5.1, §6.2).
/// @dev Enum member order is part of the ABI and of the generated client types. Never reorder.

/// @notice The seven concurrent round sequences every pool runs (SPEC §5.1, §6.1, ADR 036).
/// @dev Three daily tiers (100 / 1,000 / 10,000 USD), three weekly tiers (1,000 / 10,000 / 100,000 USD)
///      and one monthly tier (100,000 USD). The cadence drives the cutoff, the tier drives the default target.
enum Kind {
    Day100,
    Day1k,
    Day10k,
    Week1k,
    Week10k,
    Week100k,
    Month100k
}

/// @notice Cutoff cadence of a `Kind` (SPEC §6.1).
enum Cadence {
    Day,
    Week,
    Month
}

/// @dev Number of concurrent sequences per pool; equals the number of `Kind` members (SPEC §6.1).
uint256 constant KIND_COUNT = 7;

enum State {
    Open,
    AwaitingRequest,
    Drawing,
    Ready,
    Settled,
    Refunding,
    Void
}

enum ReleaseReason {
    Prize,
    Fee,
    Refund
}

enum RefundReason {
    InsufficientPlayers,
    RequestDeadlineExpired
}

enum ReferenceKind {
    ExactToken,
    UnderlyingAsset
}

enum CallbackIgnoreReason {
    UnknownRequest,
    DuplicateOrWrongState,
    Malformed
}

/// @dev Append-only ABI values. Check precedence is specified separately in SPEC §5.1 and §8.1.
enum QuoteReason {
    None,
    InvalidRound,
    EntryWindowClosed,
    InvalidAmount,
    BuysPaused,
    PriceUnavailable,
    PriceInvalid,
    PriceStale,
    PriceDecimalsChanged,
    BelowMinimum,
    InsufficientBalance,
    SeedAccountCannotBuy,
    ArithmeticOverflow
}

enum SeedSkipReason {
    NotConfigured,
    NotAuthorized,
    InsufficientSeedBalance,
    NotOpen
}

enum CloseReason {
    Cutoff,
    TargetReached
}

/// @notice Frozen per round; fixed size, no strings (SPEC §3.1, ADR 019). Bounds are zero when the aggregator has none.
struct PricingConfig {
    address feed;
    uint8 feedDecimals;
    uint32 maxPriceAge;
    ReferenceKind referenceKind;
    int256 minAnswer;
    int256 maxAnswer;
}

/// @notice One appended ownership range per accepted entry: [previousCumulativeGross, cumulativeGross).
struct Range {
    address buyer;
    uint256 cumulativeGross;
}

/// @dev Native BNB is addressed as address(0) everywhere (SPEC §1, §4.2).
address constant NATIVE_ASSET = address(0);

uint16 constant FEE_BPS = 300;
uint16 constant BPS = 10000;

/// @dev requestDeadline = closedAt + REQUEST_WINDOW (SPEC §6.2).
uint64 constant REQUEST_WINDOW = 86400;

/// @dev PricingConfig.maxPriceAge bounds (SPEC §3.1): max(2H, 3600), never outside these limits.
uint32 constant MIN_PRICE_AGE = 60;
uint32 constant MAX_PRICE_AGE = 172800;

/// @title Kinds
/// @notice Pure tier metadata for `Kind`: its cutoff cadence and its default whole-USD target (SPEC §6.1).
/// @dev Kept beside the enum so every consumer (Draw, Schedule, scripts, tests) derives the same table.
library Kinds {
    /// @notice The cutoff cadence a sequence kind follows.
    /// @param kind Round sequence kind.
    /// @return The cadence whose fixed UTC boundary is this kind's latest close.
    function cadenceOf(Kind kind) internal pure returns (Cadence) {
        if (kind == Kind.Day100 || kind == Kind.Day1k || kind == Kind.Day10k) return Cadence.Day;
        if (kind == Kind.Week1k || kind == Kind.Week10k || kind == Kind.Week100k) return Cadence.Week;
        if (kind == Kind.Month100k) return Cadence.Month;
        // Unreachable while `Kind` decodes successfully; kept so a future enum member cannot silently
        // inherit the daily cadence.
        revert InvalidKind();
    }

    /// @notice The whole-USD target a freshly added pool starts this sequence with.
    /// @param kind Round sequence kind.
    /// @return The default target in whole USD; the owner may change it for future rounds.
    function defaultTargetUsd(Kind kind) internal pure returns (uint32) {
        if (kind == Kind.Day100) return 100;
        if (kind == Kind.Day1k) return 1000;
        if (kind == Kind.Day10k) return 10_000;
        if (kind == Kind.Week1k) return 1000;
        if (kind == Kind.Week10k) return 10_000;
        if (kind == Kind.Week100k) return 100_000;
        if (kind == Kind.Month100k) return 100_000;
        revert InvalidKind();
    }
}
