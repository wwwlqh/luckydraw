// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ILuckyVault} from "./interfaces/ILuckyVault.sol";
import {NATIVE_ASSET, ReleaseReason} from "./Types.sol";
import {
    AlreadyBound,
    AlreadyListed,
    DepositsDisabled,
    DepositsPaused,
    EntryWindowClosed,
    EscrowClosed,
    InsufficientBalance,
    InvalidAmount,
    InvalidAsset,
    InvalidConfig,
    InvalidId,
    InvalidRecipient,
    RefundExceedsLocked,
    SeedAccountCannotBuy,
    SeedAlreadyLocked,
    SeedCapExceeded,
    SeedNotAuthorized,
    TransferFailed,
    TransferMismatch,
    Unauthorized,
    WrongState
} from "./Errors.sol";

/// @title LuckyVault
/// @notice Custody, available balances and per-round escrow for LuckyDraw (SPEC §4).
/// @dev The Vault has no game logic, reads no prices and makes no oracle calls. Native BNB is `address(0)`
///      with 18 decimals. There is deliberately no `receive`/`fallback`, no sweep, no upgrade path, no
///      arbitrary call and no owner path that moves user funds: `withdraw` is the only outbound transfer and
///      its recipient is always `msg.sender` (SPEC §4.3 V4). Every mutation, including owner and Draw-only
///      entry points, runs under one shared reentrancy guard, and `nonReentrant` is listed first so the
///      guard is the outermost check: a nested call is refused before any authorization branch is taken.
contract LuckyVault is ILuckyVault, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice The maximum token decimals the Vault will admit (SPEC §3.1).
    uint8 private constant MAX_DECIMALS = 18;

    /// @notice The single LuckyDraw permitted to move money between available balances and escrow.
    /// @dev Assigned once by `setDraw`; there is no replacement path (SPEC §4.1).
    address public draw;

    /// @notice Global new-deposit pause. Never gates withdrawal, escrow or release (SPEC §4.3 V3).
    bool public depositsPaused;

    /// @notice Sum of every user's available balance for an asset (SPEC §4.3 "A").
    mapping(address asset => uint256 total) public totalAvailable;

    /// @notice Sum of every registered round's escrow for an asset (SPEC §4.3 "E").
    mapping(address asset => uint256 total) public totalEscrow;

    /// @notice Gross moved into a round's escrow on behalf of a user, player and seed paths combined.
    mapping(uint256 roundId => mapping(address user => uint256 gross)) public lockedBy;

    /// @notice Gross already returned to a user for a round through `ReleaseReason.Refund`.
    mapping(uint256 roundId => mapping(address user => uint256 gross)) public refundedTo;

    /// @notice The most a single round may take from an account through `lockSeed`, per asset; 0 means no
    ///         consent for that asset.
    /// @dev Set by the account itself (SPEC §5.4). Consent is per asset because `seedAmount` is per pool in
    ///      that pool's raw units: one shared raw-unit cap sized for an 18-decimal asset would be unlimited
    ///      consent for a low-decimal token. While the cap for a round's asset is nonzero the account cannot
    ///      be debited by `lock` in that asset.
    mapping(address account => mapping(address asset => uint256 maxPerRound)) public seedMaxPerRound;

    /// @notice Amount seeded from an account into a round; nonzero means that round is already seeded.
    mapping(uint256 roundId => mapping(address account => uint256 amount)) public seedLocked;

    mapping(address user => mapping(address asset => uint256 amount)) private _balances;
    mapping(uint256 roundId => Escrow escrow) private _escrows;
    mapping(address asset => AssetRecord record) private _assets;

    /// @dev Restricts a function to the bound Draw. Reverts before binding because `msg.sender` is never zero.
    modifier onlyDraw() {
        if (msg.sender != draw) revert Unauthorized();
        _;
    }

    /// @param initialOwner The deploying operator address; ownership is later moved to the multisig in two steps.
    constructor(address initialOwner) Ownable(initialOwner) {}

    // ---------------------------------------------------------------------
    // Owner (SPEC §8.1)
    // ---------------------------------------------------------------------

    /// @notice Lists an asset for custody, initially deposit-disabled (SPEC §8.1).
    /// @dev One-time and non-duplicate. `address(0)` is native BNB and must declare 18 decimals; any other
    ///      address must have code and a `decimals()` result equal to `tokenDecimals`. The Vault's own address
    ///      and the bound Draw are rejected. Listing is immutable: there is no unlist or decimals setter.
    /// @param asset The asset address, or `address(0)` for native BNB.
    /// @param tokenDecimals The asset's decimals, 0-18, and exactly 18 for native BNB.
    function listAsset(address asset, uint8 tokenDecimals) external nonReentrant onlyOwner {
        if (_assets[asset].listed) revert AlreadyListed();
        if (asset == address(this)) revert InvalidAsset();
        if (draw != address(0) && asset == draw) revert InvalidAsset();
        if (tokenDecimals > MAX_DECIMALS) revert InvalidConfig();

        if (asset == NATIVE_ASSET) {
            if (tokenDecimals != MAX_DECIMALS) revert InvalidConfig();
        } else {
            if (asset.code.length == 0) revert InvalidAsset();
            try IERC20Metadata(asset).decimals() returns (uint8 reported) {
                if (reported != tokenDecimals) revert InvalidConfig();
            } catch {
                revert InvalidAsset();
            }
        }

        _assets[asset] = AssetRecord({listed: true, tokenDecimals: tokenDecimals, depositsEnabled: false});
        emit AssetListed(asset, tokenDecimals);
    }

    /// @notice Enables or disables new deposits for one listed asset.
    /// @dev Affects new deposits only: balances, escrow and withdrawal are untouched (SPEC §4.3 V3).
    /// @param asset The listed asset.
    /// @param enabled The new deposit enablement.
    function setDepositsEnabled(address asset, bool enabled) external nonReentrant onlyOwner {
        AssetRecord storage record = _assets[asset];
        if (!record.listed) revert InvalidAsset();

        bool oldValue = record.depositsEnabled;
        record.depositsEnabled = enabled;
        emit DepositsEnabledSet(asset, msg.sender, oldValue, enabled);
    }

    /// @notice Pauses or unpauses new deposits globally.
    /// @dev Never gates withdrawal, escrow or release (SPEC §4.3 V3).
    /// @param paused The new global deposit pause value.
    function setDepositsPaused(bool paused) external nonReentrant onlyOwner {
        bool oldValue = depositsPaused;
        depositsPaused = paused;
        emit DepositsPausedSet(msg.sender, oldValue, paused);
    }

    /// @notice Binds the single LuckyDraw permitted to lock and release escrow (SPEC §4.1).
    /// @dev One-time. The address must have code, must not be the Vault and must not be a listed asset.
    ///      Verify the intended bytecode and `Draw.vault` before enabling deposits or creating rounds.
    /// @param draw_ The LuckyDraw address.
    function setDraw(address draw_) external nonReentrant onlyOwner {
        if (draw != address(0)) revert AlreadyBound();
        if (draw_ == address(0) || draw_ == address(this)) revert InvalidConfig();
        if (draw_.code.length == 0) revert InvalidConfig();
        if (_assets[draw_].listed) revert InvalidConfig();

        draw = draw_;
        emit DrawBound(draw_, msg.sender);
    }

    /// @notice Starts a two-step ownership transfer; the zero address is rejected (SPEC §8.1).
    /// @dev Overrides `Ownable2Step`, which otherwise allows a zero pending owner. There is no renounce path.
    /// @param newOwner The address that must later call `acceptOwnership`.
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == address(0)) revert InvalidRecipient();
        super.transferOwnership(newOwner);
    }

    /// @notice Always reverts: the Vault must never become ownerless (SPEC §8.1, D6).
    function renounceOwnership() public pure override {
        revert InvalidRecipient();
    }

    // ---------------------------------------------------------------------
    // User (SPEC §4.2)
    // ---------------------------------------------------------------------

    /// @notice Deposits native BNB and credits the full `msg.value` to the caller's available balance.
    /// @dev No platform fee is taken (SPEC P5). Requires a bound Draw, native listed and deposit-enabled,
    ///      and deposits not globally paused. Forced BNB arriving any other way creates surplus, not credit.
    function depositNative() external payable nonReentrant {
        _requireDepositable(NATIVE_ASSET);
        if (msg.value == 0) revert InvalidAmount();

        _credit(msg.sender, NATIVE_ASSET, msg.value);
        emit Deposited(msg.sender, NATIVE_ASSET, msg.value);
    }

    /// @notice Deposits an exact-transfer ERC-20 and credits the full amount to the caller.
    /// @dev The native sentinel reverts `InvalidAsset` here. The Vault's own measured receipt must equal
    ///      `amount` exactly, so fee-on-transfer and rebasing tokens are rejected with `TransferMismatch`
    ///      (SPEC §3.1). The delta is measured while holding the reentrancy guard.
    /// @param asset The listed, deposit-enabled ERC-20.
    /// @param amount The raw token amount to pull from the caller.
    function deposit(address asset, uint256 amount) external nonReentrant {
        if (asset == NATIVE_ASSET) revert InvalidAsset();
        _requireDepositable(asset);
        if (amount == 0) revert InvalidAmount();

        IERC20 token = IERC20(asset);
        uint256 balanceBefore = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter < balanceBefore || balanceAfter - balanceBefore != amount) revert TransferMismatch();

        _credit(msg.sender, asset, amount);
        emit Deposited(msg.sender, asset, amount);
    }

    /// @notice Withdraws an available balance to the caller's own address.
    /// @dev The only outbound asset transfer in the contract and the recipient is always `msg.sender`
    ///      (SPEC §4.3 V4). Never gated by `depositsPaused`, deposit enablement, price or round state
    ///      (V3). Balances are debited before the transfer; any failure reverts the whole transaction and
    ///      leaves the ledger unchanged. ERC-20 transfers additionally check the exact Vault debit and
    ///      recipient receipt, so a taxed transfer reverts with `TransferMismatch`.
    /// @param asset The listed asset, or `address(0)` for native BNB.
    /// @param amount The raw amount to withdraw.
    function withdraw(address asset, uint256 amount) external nonReentrant {
        if (!_assets[asset].listed) revert InvalidAsset();
        if (amount == 0) revert InvalidAmount();

        uint256 balance = _balances[msg.sender][asset];
        if (balance < amount) revert InsufficientBalance();

        // Effects first: the caller is debited before any external interaction.
        unchecked {
            _balances[msg.sender][asset] = balance - amount;
        }
        totalAvailable[asset] -= amount;

        if (asset == NATIVE_ASSET) {
            (bool ok,) = payable(msg.sender).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20 token = IERC20(asset);
            uint256 vaultBefore = token.balanceOf(address(this));
            uint256 recipientBefore = token.balanceOf(msg.sender);
            token.safeTransfer(msg.sender, amount);
            uint256 vaultAfter = token.balanceOf(address(this));
            uint256 recipientAfter = token.balanceOf(msg.sender);
            if (vaultAfter > vaultBefore || vaultBefore - vaultAfter != amount) revert TransferMismatch();
            if (recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount) {
                revert TransferMismatch();
            }
        }

        emit Withdrawn(msg.sender, asset, amount);
    }

    /// @notice Records the caller's own consent to be debited as an operator seed in one asset, capped per
    ///         round.
    /// @dev Pointing Draw at an account is not consent (SPEC §5.4): only this call, made by the account
    ///      itself, permits `lockSeed`. Consent is per asset and the cap is in that asset's raw units, so a
    ///      cap sized for BNB grants nothing in a 2-decimal token pool. Setting 0 revokes that asset alone.
    ///      While the cap for an asset is nonzero the caller cannot be debited through the player path
    ///      `lock` in that asset at all.
    /// @param asset The listed asset the consent covers, or `address(0)` for native BNB.
    /// @param maxPerRound The most any single round in that asset may take from the caller; 0 revokes.
    function authorizeSeed(address asset, uint256 maxPerRound) external nonReentrant {
        if (!_assets[asset].listed) revert InvalidAsset();

        uint256 oldMaxPerRound = seedMaxPerRound[msg.sender][asset];
        seedMaxPerRound[msg.sender][asset] = maxPerRound;
        emit SeedAuthorized(msg.sender, asset, oldMaxPerRound, maxPerRound);
    }

    // ---------------------------------------------------------------------
    // Draw only (SPEC §4.2, V5)
    // ---------------------------------------------------------------------

    /// @notice Registers a round with zero escrow and its entry cutoff.
    /// @dev Independent of deposit enablement or the global pause. IDs start at one and are never reused.
    /// @param id The Draw's round identifier; must be nonzero and unused.
    /// @param asset The listed asset this round's escrow is denominated in.
    /// @param closesAt The entry cutoff; strictly in the future.
    function registerRound(uint256 id, address asset, uint64 closesAt) external nonReentrant onlyDraw {
        if (id == 0) revert InvalidId();
        Escrow storage escrow = _escrows[id];
        if (escrow.registered) revert InvalidId();
        if (!_assets[asset].listed) revert InvalidAsset();
        if (closesAt <= block.timestamp) revert InvalidConfig();

        escrow.asset = asset;
        escrow.closesAt = closesAt;
        escrow.registered = true;
        emit RoundRegistered(id, asset);
    }

    /// @notice Moves a buyer's gross entry from their available balance into a round's escrow.
    /// @dev Vault-enforced limits independent of Draw (SPEC §4.3 V5): no lock at or after `closesAt`, after
    ///      `closeEscrow`, or after the round's first release; and an account holding a seed authorization
    ///      for this round's asset is never debited through this path.
    /// @param id The registered round.
    /// @param buyer The account debited; must be nonzero and must hold no seed authorization for the
    ///        round's asset. A cap on some other asset does not block buying here.
    /// @param amount The full gross entry, fee reserve included.
    function lock(uint256 id, address buyer, uint256 amount) external nonReentrant onlyDraw {
        Escrow storage escrow = _requireLockable(id);
        if (buyer == address(0)) revert InvalidRecipient();
        if (seedMaxPerRound[buyer][escrow.asset] != 0) revert SeedAccountCannotBuy();
        if (amount == 0) revert InvalidAmount();

        _moveToEscrow(escrow, id, buyer, amount);
    }

    /// @notice Moves the operator seed from an authorizing account into a round's escrow.
    /// @dev The only path that debits an account without a per-transaction signature (SPEC §5.4, D9): the
    ///      account must have set its own cap for this round's asset, the amount must fit inside it, and a
    ///      round can be seeded from an account at most once.
    /// @param id The registered round.
    /// @param account The seed account that called `authorizeSeed` for this round's asset.
    /// @param amount The seed gross; must be nonzero and at most the authorized cap for the round's asset.
    function lockSeed(uint256 id, address account, uint256 amount) external nonReentrant onlyDraw {
        Escrow storage escrow = _requireLockable(id);
        uint256 cap = seedMaxPerRound[account][escrow.asset];
        if (cap == 0) revert SeedNotAuthorized();
        if (amount == 0) revert InvalidAmount();
        if (amount > cap) revert SeedCapExceeded();
        if (seedLocked[id][account] != 0) revert SeedAlreadyLocked();

        seedLocked[id][account] = amount;
        _moveToEscrow(escrow, id, account, amount);
    }

    /// @notice Marks a round closed so no further lock is possible, even before `closesAt`.
    /// @dev Called by every closing branch of Draw, including a target close (SPEC §4.2).
    /// @param id The registered round.
    function closeEscrow(uint256 id) external nonReentrant onlyDraw {
        Escrow storage escrow = _escrows[id];
        if (!escrow.registered) revert InvalidId();
        if (escrow.closed) revert EscrowClosed();

        escrow.closed = true;
        emit RoundEscrowClosed(id);
    }

    /// @notice Moves escrow to a recipient's available balance as a prize, earned fee or gross refund.
    /// @dev Makes no asset call: winnings and refunds are balance credits (SPEC P9, A38). A `Refund` can
    ///      never exceed what that recipient locked in that round (V5). The first release marks the round
    ///      released, which permanently blocks further locks. A release can only spend this round's escrow.
    /// @param id The registered round.
    /// @param recipient The credited account; must be nonzero and neither the Vault nor the Draw.
    /// @param amount The raw amount; must be nonzero and at most the round's remaining escrow.
    /// @param reason Prize, Fee or Refund.
    function release(uint256 id, address recipient, uint256 amount, ReleaseReason reason)
        external
        nonReentrant
        onlyDraw
    {
        Escrow storage escrow = _escrows[id];
        if (!escrow.registered) revert InvalidId();
        if (recipient == address(0) || recipient == address(this) || recipient == draw) revert InvalidRecipient();
        if (amount == 0) revert InvalidAmount();
        if (amount > escrow.amount) revert InsufficientBalance();

        if (reason == ReleaseReason.Refund) {
            uint256 refunded = refundedTo[id][recipient] + amount;
            if (refunded > lockedBy[id][recipient]) revert RefundExceedsLocked();
            refundedTo[id][recipient] = refunded;
        }

        address asset = escrow.asset;
        escrow.released = true;
        unchecked {
            escrow.amount -= amount;
        }
        totalEscrow[asset] -= amount;
        _credit(recipient, asset, amount);

        emit FundsReleased(id, recipient, asset, amount, reason);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Returns a user's available balance for an asset.
    /// @param user The account.
    /// @param asset The listed asset, or `address(0)` for native BNB.
    /// @return The available balance in raw units.
    function balanceOf(address user, address asset) external view returns (uint256) {
        return _balances[user][asset];
    }

    /// @notice Returns a round's escrow record.
    /// @param id The round identifier.
    /// @return The escrow record; `registered` is false for an unknown id.
    function getEscrow(uint256 id) external view returns (Escrow memory) {
        return _escrows[id];
    }

    /// @notice Returns an asset's admission record.
    /// @param asset The asset address, or `address(0)` for native BNB.
    /// @return The record; `listed` is false for an unlisted asset.
    function getAsset(address asset) external view returns (AssetRecord memory) {
        return _assets[asset];
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Shared deposit guards: bound Draw, listed, deposit-enabled, and not globally paused.
    function _requireDepositable(address asset) private view {
        if (draw == address(0)) revert WrongState();
        AssetRecord storage record = _assets[asset];
        if (!record.listed) revert InvalidAsset();
        if (!record.depositsEnabled) revert DepositsDisabled();
        if (depositsPaused) revert DepositsPaused();
    }

    /// @dev Shared round guards for `lock` and `lockSeed` (SPEC §4.3 V5).
    function _requireLockable(uint256 id) private view returns (Escrow storage escrow) {
        escrow = _escrows[id];
        if (!escrow.registered) revert InvalidId();
        if (block.timestamp >= escrow.closesAt) revert EntryWindowClosed();
        if (escrow.closed || escrow.released) revert EscrowClosed();
    }

    /// @dev Moves `amount` of the round's asset from `account`'s available balance into the round escrow.
    function _moveToEscrow(Escrow storage escrow, uint256 id, address account, uint256 amount) private {
        address asset = escrow.asset;
        uint256 balance = _balances[account][asset];
        if (balance < amount) revert InsufficientBalance();

        unchecked {
            _balances[account][asset] = balance - amount;
        }
        totalAvailable[asset] -= amount;
        totalEscrow[asset] += amount;
        escrow.amount += amount;
        lockedBy[id][account] += amount;

        emit FundsLocked(id, account, asset, amount);
    }

    /// @dev Credits an available balance and keeps `totalAvailable` equal to the sum of balances (V2).
    function _credit(address account, address asset, uint256 amount) private {
        _balances[account][asset] += amount;
        totalAvailable[asset] += amount;
    }
}
