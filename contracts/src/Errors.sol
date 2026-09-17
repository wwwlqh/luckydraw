// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Custom errors shared by LuckyVault and LuckyDraw (SPEC §8.1).
/// @dev Arithmetic overflow surfaces as Solidity Panic(0x11); there is deliberately no ArithmeticOverflow error.

// Identity and configuration
error InvalidId();
error InvalidKind();
error InvalidConfig();
error InvalidAmount();
error InvalidRecipient();
error InvalidAsset();
error Unauthorized();
error AlreadyBound();
error AlreadyListed();
error AlreadyClaimed();

// State and time
error WrongState();
error EntryWindowClosed();
error RoundNotClosed();
error RequestWindowClosed();
error RequestWindowStillOpen();
error DeadlineExpired();

// Pauses and enablement
error DepositsPaused();
error DepositsDisabled();
error BuysPaused();
error PoolDisabled();

// Balances and transfers
error InsufficientBalance();
error TransferMismatch();
error TransferFailed();

// Vault per-round limits (V5)
error EscrowClosed();
error RefundExceedsLocked();
error SeedCapExceeded();
error SeedAlreadyLocked();
error SeedAccountCannotBuy();

// Price reference (SPEC §3.2)
error PriceUnavailable();
error PriceInvalid();
error PriceStale();
error PriceDecimalsChanged();
error BelowMinimum();
error NetContributionTooLow();

// Randomness request pre-checks (SPEC §6.2, §7.1)
error InvalidRequestId();
error KeyHashUnsupported();
error SubscriptionUnderfunded();

// Operator seed (SPEC §5.4)
error SeedNotConfigured();
error SeedNotAuthorized();
error InsufficientSeedBalance();
error AlreadySeeded();
