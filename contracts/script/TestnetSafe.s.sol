// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ConfigureBase} from "./Configure.s.sol";
import {DeploymentLib} from "./DeploymentLib.sol";
import {ILuckyDraw} from "../src/interfaces/ILuckyDraw.sol";
import {ILuckyVault} from "../src/interfaces/ILuckyVault.sol";
import {LuckyDraw} from "../src/LuckyDraw.sol";
import {LuckyVault} from "../src/LuckyVault.sol";
import {KIND_COUNT, Kind} from "../src/Types.sol";

/// @notice The Safe v1.4.1 proxy factory: the one call that creates a Safe.
interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy);
}

/// @notice The Safe v1.4.1 surface this script needs: setup, ownership queries and `execTransaction`.
interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes memory signatures
    ) external payable returns (bool success);

    function VERSION() external view returns (string memory);
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
}

/// @title TestnetSafe
/// @notice Creates and drives the single operator Safe of a BSC testnet deployment from the command line.
/// @dev The Safe web interface lists BNB Chain mainnet only (checked against `safe-client.safe.global/v1/chains`
///      on 2026-09-16: chain 56 is present, chain 97 is not), while the Safe v1.4.1 contracts are deployed on
///      chain 97 at the canonical addresses of Safe's own deployment records. So the testnet runbook cannot say
///      "create it in the UI"; this script does what the UI would have done, against the real Safe contracts,
///      and nothing else. SPEC §12.1 allows one operator Safe for all three privileged roles on testnet; on
///      mainnet the roles are three distinct 2-of-3 Safes created in the UI (SPEC §10.5), and this script refuses
///      chain 56 outright so nobody drives a mainnet Safe through a 1-of-1 shortcut.
///
///      Two entry points, both run with the operator's own signer flags and never a key on the command line:
///
///      - `create()`: deploys a 1-of-1 Safe owned by the broadcaster through the proxy factory, then reads the
///        owners, threshold, version and module list back from the chain before printing the address that goes
///        into the plan's `ownership.finalOwner`, `feeAccount` and `seedAccount`.
///      - `ops()`: after `Deploy` and `Configure`, executes the four owner actions of the runbook *through the
///        Safe* (pre-validated owner signature, the Safe's own `execTransaction`): accept ownership of the Vault
///        and the Draw, deposit the native seed balance, and `authorizeSeed` for every asset in the manifest at
///        that asset's own per-round cap (the manifest's `pool.seedAuthorizedMaxPerRound`, a per-symbol
///        `SEED_MAX_PER_ROUND_<SYMBOL>`, or the single global `SEED_MAX_PER_ROUND` when it can only mean one
///        asset; the order is on `ops()` below). Every step reads the live state first and is skipped when it
///        already matches, so a stopped run is simply run again. It writes nothing: `Configure` (idempotent)
///        re-reads the chain afterwards and records
///        `ownershipAccepted` and the authorized cap, and `Verify` checks them.
///      - `assets()`: adds an asset to a deployment that is **already live**. `Configure` cannot: every one of its
///        mutating steps is guarded by `_requireOwner(owner, broadcaster, ...)`, and once the Safe has accepted
///        ownership the broadcaster is no longer the owner, so a `Configure` run that finds an unlisted asset
///        stops at `listAsset`. This entry point performs the same steps in the same order — `listAsset`,
///        `setDepositsEnabled`, `addPool`, `setSeedAmount`, `setTargetUsd`, `setPoolEnabled` — as the Safe, with
///        `Configure`'s own `_requireVrfReady` guard before `addPool` and `Configure`'s skip-what-matches
///        behaviour throughout, and it also performs the ERC-20 `approve`/`deposit` pair a token seed balance
///        needs. It writes nothing either: `Configure` afterwards has no owner action left to take, so it runs
///        as the plain operator and records the new `poolId`, `firstRoundIds`, `listed` and authorized cap.
contract TestnetSafe is ConfigureBase {
    /// @notice BSC testnet, the only chain this script is for; anvil is allowed so the in-process tests can run it.
    uint256 internal constant BSC_TESTNET = 97;
    uint256 internal constant ANVIL = 31337;

    /// @notice The native asset sentinel of the Vault (SPEC §3.1).
    address internal constant NATIVE_ASSET = address(0);

    /// @notice Safe's `Enum.Operation.Call`.
    uint8 internal constant OPERATION_CALL = 0;

    /// @notice The Safe release whose canonical deployments cover chain 97.
    string internal constant SAFE_VERSION = "1.4.1";

    // ---------------------------------------------------------------------
    // create
    // ---------------------------------------------------------------------

    /// @notice Creates the 1-of-1 operator Safe owned by the broadcaster.
    /// @dev Environment: `SAFE_PROXY_FACTORY`, `SAFE_SINGLETON` and `SAFE_FALLBACK_HANDLER` are the canonical
    ///      v1.4.1 addresses for the connected chain, read by the operator from Safe's deployment records and
    ///      verified here to have code and to report `VERSION() == "1.4.1"`; `SAFE_SALT_NONCE` (optional) makes the
    ///      address reproducible, and defaults to the block timestamp so two runs never collide on CREATE2.
    /// @return safe The new Safe, already verified against the chain.
    function create() external returns (address safe) {
        return createFor(
            vm.envAddress("SAFE_PROXY_FACTORY"),
            vm.envAddress("SAFE_SINGLETON"),
            vm.envAddress("SAFE_FALLBACK_HANDLER"),
            vm.envOr("SAFE_SALT_NONCE", block.timestamp),
            msg.sender
        );
    }

    /// @notice `create()` with explicit inputs, for the tests.
    function createFor(address factory, address singleton, address fallbackHandler, uint256 saltNonce, address owner)
        public
        returns (address safe)
    {
        _requireTestnet();
        require(factory.code.length > 0, "TestnetSafe: SAFE_PROXY_FACTORY has no code on this chain");
        require(singleton.code.length > 0, "TestnetSafe: SAFE_SINGLETON has no code on this chain");
        require(fallbackHandler.code.length > 0, "TestnetSafe: SAFE_FALLBACK_HANDLER has no code on this chain");
        require(
            DeploymentLib.eq(ISafe(singleton).VERSION(), SAFE_VERSION),
            string.concat(
                "TestnetSafe: SAFE_SINGLETON reports VERSION() ", ISafe(singleton).VERSION(), ", expected 1.4.1"
            )
        );
        require(owner != address(0), "TestnetSafe: no broadcaster");

        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory initializer = abi.encodeCall(
            ISafe.setup, (owners, 1, address(0), "", fallbackHandler, address(0), 0, payable(address(0)))
        );

        vm.startBroadcast(owner);
        safe = ISafeProxyFactory(factory).createProxyWithNonce(singleton, initializer, saltNonce);
        vm.stopBroadcast();

        _verifySafe(safe, owner);

        console2.log("TestnetSafe: created", safe);
        console2.log("TestnetSafe: owner", owner);
        console2.log("TestnetSafe: threshold 1 of 1, no modules, version", SAFE_VERSION);
        console2.log("TestnetSafe: put this address in ownership.finalOwner, feeAccount and seedAccount of the plan");
    }

    // ---------------------------------------------------------------------
    // ops
    // ---------------------------------------------------------------------

    /// @notice Runs the four owner actions of the testnet runbook through the Safe.
    /// @dev Environment: `LUCKYDRAW_MANIFEST` is the manifest written by `Configure`; `SEED_DEPOSIT_WEI` (optional,
    ///      default 0) is the native balance to deposit into the Vault as the seed account. When the Safe holds less
    ///      than that, the broadcaster tops the Safe up first with a plain transfer, so one faucet balance is enough.
    ///
    ///      The per-round cap is **per asset**, because one number cannot be right for two assets: a cap in wei of
    ///      BNB and a cap in raw units of an 18-decimal token differ by orders of magnitude, and a single global
    ///      value silently raises one of them. The cap for each asset is resolved in this order:
    ///
    ///      1. `SEED_MAX_PER_ROUND_<SYMBOL>` (e.g. `SEED_MAX_PER_ROUND_USDT`), when set and nonzero — the explicit
    ///         per-symbol form, which is the one to use whenever more than one asset still needs a cap;
    ///      2. the manifest's own `assets[i].pool.seedAuthorizedMaxPerRound`, when it is present and nonzero;
    ///      3. `SEED_MAX_PER_ROUND` (optional), the single global override, which applies **only** to assets that
    ///         reached this step. If it would apply to more than one asset the run is refused, because it would then
    ///         be setting two different assets' caps to the same raw number;
    ///      4. that asset's `seedAmount`.
    ///
    ///      A cap below `seedAmount` is refused wherever it came from. Step 2 is what makes a second run of this
    ///      entry point — the one the runbook's §4a step 4 asks for after a new asset is added — leave the caps of
    ///      the assets that are already authorized exactly as they are: `Configure` recorded them from the chain.
    function ops() external {
        opsAt(
            vm.envString("LUCKYDRAW_MANIFEST"),
            vm.envOr("SEED_DEPOSIT_WEI", uint256(0)),
            vm.envOr("SEED_MAX_PER_ROUND", uint256(0)),
            msg.sender
        );
    }

    /// @notice `ops()` with explicit inputs, for the tests.
    /// @param seedMaxPerRound The global `SEED_MAX_PER_ROUND` override; the per-symbol `SEED_MAX_PER_ROUND_<SYMBOL>`
    ///        form is read from the environment, because the symbols are only known once the manifest is read.
    function opsAt(string memory manifestPath, uint256 seedDepositWei, uint256 seedMaxPerRound, address owner) public {
        opsAt(manifestPath, seedDepositWei, seedMaxPerRound, new string[](0), new uint256[](0), owner);
    }

    /// @notice `opsAt` with the per-symbol overrides supplied directly instead of through the environment.
    /// @dev `forge test` runs the functions of one test contract concurrently in a single process, so a test that
    ///      set `SEED_MAX_PER_ROUND_<SYMBOL>` with `vm.setEnv` would leak that value into its neighbours. The tests
    ///      pass the same overrides here; `ops()` is the form that reads them from the environment.
    /// @param overrideSymbols Asset symbols, exactly as the manifest spells them.
    /// @param overrideCaps The cap for each of those symbols, in that asset's raw units; parallel to the symbols.
    function opsAt(
        string memory manifestPath,
        uint256 seedDepositWei,
        uint256 seedMaxPerRound,
        string[] memory overrideSymbols,
        uint256[] memory overrideCaps,
        address owner
    ) public {
        require(overrideSymbols.length == overrideCaps.length, "TestnetSafe: per-symbol override arrays differ");
        _requireTestnet();
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        address safe = _checkLayout(m, owner);
        LuckyVault vault = LuckyVault(payable(m.vault.addr));
        LuckyDraw draw = LuckyDraw(m.draw.addr);

        // Resolved before anything is broadcast: an ambiguous or too-low cap stops the run before it accepts
        // ownership or moves money, rather than half-way through the four owner actions.
        uint256[] memory caps = _resolveCaps(m, seedMaxPerRound, overrideSymbols, overrideCaps);

        vm.startBroadcast(owner);
        _acceptOwnership(safe, owner, address(vault), vault.owner(), vault.pendingOwner(), "Vault");
        _acceptOwnership(safe, owner, address(draw), draw.owner(), draw.pendingOwner(), "Draw");
        _deposit(safe, owner, vault, seedDepositWei);
        for (uint256 i = 0; i < m.assets.length; i++) {
            _authorize(safe, owner, vault, m.assets[i], caps[i]);
        }
        vm.stopBroadcast();

        console2.log("TestnetSafe: Vault balance of the Safe", vault.balanceOf(safe, NATIVE_ASSET));
        console2.log("TestnetSafe: now run Configure again to record the accepted ownership, then Verify");
    }

    // ---------------------------------------------------------------------
    // assets
    // ---------------------------------------------------------------------

    /// @notice Lists the manifest's assets and opens their pools through the Safe, on a deployment already handed over.
    /// @dev Environment: `LUCKYDRAW_MANIFEST` is the manifest, which must already carry the asset entry (identity,
    ///      price record and `pool`) that is being added — this script opens what the manifest says, it never invents
    ///      an asset. `TOKEN_DEPOSIT` (optional, default 0) is the amount to approve and deposit into the Vault as the
    ///      seed balance of the manifest's **one** non-native asset, in that asset's raw units; unset or 0 deposits
    ///      nothing, and a second run with a value deposits again, because a deposit is an amount and not a state. It
    ///      is one number, so a manifest with more than one non-native asset refuses it rather than depositing the
    ///      same raw amount of two different tokens: list the assets with `TOKEN_DEPOSIT` unset and deposit each
    ///      token's seed balance by hand (`approve(vault, amount)` then `deposit(asset, amount)` as the Safe). The
    ///      native seed balance and `authorizeSeed` stay in `ops()`, which is run afterwards.
    function assets() external {
        assetsAt(vm.envString("LUCKYDRAW_MANIFEST"), vm.envOr("TOKEN_DEPOSIT", uint256(0)), msg.sender);
    }

    /// @notice `assets()` with explicit inputs, for the tests.
    function assetsAt(string memory manifestPath, uint256 tokenDeposit, address owner) public {
        _requireTestnet();
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        address safe = _checkLayout(m, owner);
        LuckyVault vault = LuckyVault(payable(m.vault.addr));
        LuckyDraw draw = LuckyDraw(m.draw.addr);

        // The same identity checks `Configure` makes before it touches a live pair: a manifest that has drifted from
        // the chain is not the document to open a pool from (SPEC §7.1 fixes the VRF immutables with no setter).
        require(m.vault.codeHash == address(vault).codehash, "TestnetSafe: Vault code hash differs from the manifest");
        require(m.draw.codeHash == address(draw).codehash, "TestnetSafe: Draw code hash differs from the manifest");
        require(vault.draw() == address(draw), "TestnetSafe: Vault is not bound to the manifest's Draw");
        require(address(draw.VAULT()) == address(vault), "TestnetSafe: Draw is not bound to the manifest's Vault");
        require(
            address(draw.VRF_COORDINATOR()) == m.vrf.coordinator, "TestnetSafe: vrf.coordinator differs from the Draw"
        );
        require(draw.SUBSCRIPTION_ID() == m.vrf.subscriptionId, "TestnetSafe: vrf.subscriptionId differs from the Draw");
        require(draw.KEY_HASH() == m.vrf.keyHash, "TestnetSafe: vrf.keyHash differs from the Draw");
        require(
            DeploymentLib.eq(m.environment, "local") || !DeploymentLib.referencesMocks(m),
            "TestnetSafe: a non-local manifest may reference no mock artifact (SPEC 12)"
        );
        // This entry point exists only for the handed-over case. Before acceptance `Configure` is still the right
        // tool and is the one the runbook uses, so say that rather than silently doing its job a second way.
        require(
            vault.owner() == safe && draw.owner() == safe,
            "TestnetSafe: the Safe does not own both contracts yet; use Configure until ops() has accepted ownership"
        );

        // `TOKEN_DEPOSIT` is a single raw amount and raw amounts are not comparable across tokens, so it may only
        // be given when the manifest names exactly one non-native asset for it to mean.
        if (tokenDeposit != 0) {
            uint256 tokens = 0;
            for (uint256 i = 0; i < m.assets.length; i++) {
                if (!m.assets[i].native) tokens += 1;
            }
            require(
                tokens <= 1,
                "TestnetSafe: TOKEN_DEPOSIT is one raw amount but the manifest names more than one non-native asset;"
                " run without it and deposit each token's seed balance by hand (approve then deposit, as the Safe)"
            );
        }

        vm.startBroadcast(owner);
        for (uint256 i = 0; i < m.assets.length; i++) {
            _openAsset(safe, owner, m, i, vault, draw, tokenDeposit);
        }
        vm.stopBroadcast();

        console2.log("TestnetSafe: now run ops() to authorize the seed, then Configure, Finalize and Verify");
    }

    /// @dev `ConfigureBase._configureAsset` performed as the Safe: same order, same skips, same VRF guard.
    function _openAsset(
        address safe,
        address owner,
        DeploymentLib.Manifest memory m,
        uint256 i,
        LuckyVault vault,
        LuckyDraw draw,
        uint256 tokenDeposit
    ) internal {
        DeploymentLib.AssetSpec memory a = m.assets[i];
        ILuckyVault.AssetRecord memory record = vault.getAsset(a.asset);

        if (!record.listed) {
            require(a.decimals <= type(uint8).max, string.concat("TestnetSafe: decimals out of range for ", a.symbol));
            _exec(safe, owner, address(vault), 0, abi.encodeCall(LuckyVault.listAsset, (a.asset, uint8(a.decimals))));
            console2.log("TestnetSafe: listed", a.symbol, a.asset);
        } else {
            require(
                record.tokenDecimals == a.decimals,
                string.concat("TestnetSafe: ", a.symbol, " is listed with different decimals than the manifest")
            );
            console2.log("TestnetSafe: already listed, skipped", a.symbol);
        }

        if (vault.getAsset(a.asset).depositsEnabled != a.depositsEnabled) {
            _exec(
                safe,
                owner,
                address(vault),
                0,
                abi.encodeCall(LuckyVault.setDepositsEnabled, (a.asset, a.depositsEnabled))
            );
            console2.log("TestnetSafe: depositsEnabled set", a.symbol, a.depositsEnabled);
        }

        uint256 poolId = _findPool(draw, a.asset);
        if (poolId == 0) {
            _requireVrfReady(m.vrf, address(draw));
            _exec(
                safe, owner, address(draw), 0, abi.encodeCall(LuckyDraw.addPool, (a.asset, DeploymentLib.pricingOf(a)))
            );
            poolId = _findPool(draw, a.asset);
            require(poolId != 0, "TestnetSafe: addPool left no pool for this asset");
            console2.log("TestnetSafe: pool created", a.symbol, poolId);
        } else {
            console2.log("TestnetSafe: pool already exists, skipped", a.symbol, poolId);
        }

        ILuckyDraw.PoolView memory pool = draw.getPool(poolId);
        if (pool.seedAmount != a.pool.seedAmount) {
            _exec(safe, owner, address(draw), 0, abi.encodeCall(LuckyDraw.setSeedAmount, (poolId, a.pool.seedAmount)));
            console2.log("TestnetSafe: seedAmount set", a.symbol, a.pool.seedAmount);
        }

        for (uint256 k = 0; k < KIND_COUNT; ++k) {
            if (pool.targetUsd[k] == a.pool.targetsUsd[k]) continue;
            require(a.pool.targetsUsd[k] <= type(uint32).max, "TestnetSafe: targetUsd out of range");
            _exec(
                safe,
                owner,
                address(draw),
                0,
                abi.encodeCall(LuckyDraw.setTargetUsd, (poolId, Kind(k), uint32(a.pool.targetsUsd[k])))
            );
            console2.log("TestnetSafe: target set", DeploymentLib.kindName(Kind(k)), a.pool.targetsUsd[k]);
            // SPEC §8.1, as in Configure: a round's own target never changes, so the seven rounds `addPool` just
            // opened keep the contract defaults and the manifest's target starts with the next one.
            console2.log("TestnetSafe: WARNING the first round of this kind keeps the default target");
        }

        if (pool.enabled != a.pool.enabled) {
            _exec(safe, owner, address(draw), 0, abi.encodeCall(LuckyDraw.setPoolEnabled, (poolId, a.pool.enabled)));
            console2.log("TestnetSafe: poolEnabled set", a.symbol, a.pool.enabled);
        }

        _depositToken(safe, owner, vault, a, tokenDeposit);
    }

    /// @dev The ERC-20 half of the seed balance: `approve(vault, amount)` on the token, then `deposit(asset, amount)`
    ///      on the Vault, both as the Safe and never an approval to the Draw. The approval is for the exact amount
    ///      (SPEC §9.5), and a stale nonzero allowance is reset to zero first so a token that refuses a
    ///      nonzero-to-nonzero `approve` cannot strand the run — the safe direction costs one extra transaction. The
    ///      credited balance is compared with the amount afterwards, which is the §3.1 exact-receipt check observed
    ///      against the real token rather than read off its bytecode.
    function _depositToken(
        address safe,
        address owner,
        LuckyVault vault,
        DeploymentLib.AssetSpec memory a,
        uint256 tokenDeposit
    ) internal {
        if (a.native) return;
        if (tokenDeposit == 0) {
            console2.log("TestnetSafe: TOKEN_DEPOSIT is 0, no token deposit made for", a.symbol);
            return;
        }
        IERC20 token = IERC20(a.asset);
        require(
            token.balanceOf(safe) >= tokenDeposit,
            string.concat("TestnetSafe: the Safe does not hold enough ", a.symbol, " to deposit")
        );
        if (token.allowance(safe, address(vault)) != 0) {
            _exec(safe, owner, a.asset, 0, abi.encodeCall(IERC20.approve, (address(vault), 0)));
        }
        _exec(safe, owner, a.asset, 0, abi.encodeCall(IERC20.approve, (address(vault), tokenDeposit)));

        uint256 before = vault.balanceOf(safe, a.asset);
        _exec(safe, owner, address(vault), 0, abi.encodeCall(LuckyVault.deposit, (a.asset, tokenDeposit)));
        require(
            vault.balanceOf(safe, a.asset) - before == tokenDeposit,
            string.concat("TestnetSafe: the Vault credited a different amount than deposited for ", a.symbol)
        );
        require(
            token.allowance(safe, address(vault)) == 0,
            string.concat("TestnetSafe: the Vault left an allowance behind for ", a.symbol)
        );
        console2.log("TestnetSafe: deposited token seed balance", a.symbol, tokenDeposit);
    }

    // ---------------------------------------------------------------------
    // internals
    // ---------------------------------------------------------------------

    /// @dev The manifest is for this chain, is not mainnet, names one Safe for all three roles, and that Safe is
    ///      the broadcaster's 1-of-1.
    function _checkLayout(DeploymentLib.Manifest memory m, address owner) internal view returns (address safe) {
        require(
            block.chainid == m.chain.chainId,
            string.concat(
                "TestnetSafe: chain id mismatch: connected to ",
                vm.toString(block.chainid),
                " but the manifest targets ",
                vm.toString(m.chain.chainId)
            )
        );
        require(
            !DeploymentLib.eq(m.environment, "mainnet"),
            "TestnetSafe: mainnet Safes are three distinct 2-of-3 Safes driven from the Safe interface (SPEC 10.5)"
        );
        safe = m.ownership.finalOwner;
        require(
            safe == m.ownership.feeAccount && safe == m.ownership.seedAccount,
            "TestnetSafe: this script drives the single-Safe testnet layout only; the manifest names more than one"
        );
        _verifySafe(safe, owner);
        require(m.vault.addr != address(0) && m.draw.addr != address(0), "TestnetSafe: manifest has no deployed pair");
    }

    function _deposit(address safe, address owner, LuckyVault vault, uint256 seedDepositWei) internal {
        if (seedDepositWei == 0) {
            console2.log("TestnetSafe: SEED_DEPOSIT_WEI is 0, no deposit made");
            return;
        }
        if (safe.balance < seedDepositWei) {
            uint256 topUp = seedDepositWei - safe.balance;
            (bool sent,) = payable(safe).call{value: topUp}("");
            require(sent, "TestnetSafe: top-up transfer to the Safe failed");
            console2.log("TestnetSafe: topped the Safe up by", topUp);
        }
        _exec(safe, owner, address(vault), seedDepositWei, abi.encodeCall(LuckyVault.depositNative, ()));
        console2.log("TestnetSafe: deposited native seed balance", seedDepositWei);
    }

    /// @dev The per-asset cap, resolved by the four-step order documented on `ops()`. Read-only and run before the
    ///      first broadcast, so an ambiguous global override or a cap below `seedAmount` stops the run early.
    /// @param globalOverride `SEED_MAX_PER_ROUND`, which may apply to at most one asset.
    function _resolveCaps(
        DeploymentLib.Manifest memory m,
        uint256 globalOverride,
        string[] memory overrideSymbols,
        uint256[] memory overrideCaps
    ) internal view returns (uint256[] memory caps) {
        caps = new uint256[](m.assets.length);
        uint256 globalUses = 0;
        string memory globalSymbols = "";
        for (uint256 i = 0; i < m.assets.length; i++) {
            DeploymentLib.AssetSpec memory a = m.assets[i];
            uint256 perSymbol = _perSymbol(a.symbol, overrideSymbols, overrideCaps);
            string memory recorded = a.pool.seedAuthorizedMaxPerRound;
            uint256 fromManifest = bytes(recorded).length == 0 ? 0 : vm.parseUint(recorded);
            if (perSymbol != 0) {
                caps[i] = perSymbol;
            } else if (fromManifest != 0) {
                caps[i] = fromManifest;
            } else if (globalOverride != 0) {
                caps[i] = globalOverride;
                globalUses += 1;
                globalSymbols =
                    bytes(globalSymbols).length == 0 ? a.symbol : string.concat(globalSymbols, ", ", a.symbol);
            } else {
                caps[i] = a.pool.seedAmount;
            }
            require(
                caps[i] >= a.pool.seedAmount,
                string.concat("TestnetSafe: authorized cap below seedAmount for ", a.symbol)
            );
        }
        require(
            globalUses <= 1,
            string.concat(
                "TestnetSafe: SEED_MAX_PER_ROUND would set the same raw cap on more than one asset (",
                globalSymbols,
                "); give each one SEED_MAX_PER_ROUND_<SYMBOL> or record pool.seedAuthorizedMaxPerRound in the manifest"
            )
        );
    }

    /// @dev The explicit override for one symbol, else `SEED_MAX_PER_ROUND_<SYMBOL>` from the environment, else 0.
    function _perSymbol(string memory symbol, string[] memory symbols, uint256[] memory values)
        internal
        view
        returns (uint256)
    {
        for (uint256 i = 0; i < symbols.length; i++) {
            if (DeploymentLib.eq(symbols[i], symbol)) return values[i];
        }
        return vm.envOr(string.concat("SEED_MAX_PER_ROUND_", symbol), uint256(0));
    }

    function _authorize(address safe, address owner, LuckyVault vault, DeploymentLib.AssetSpec memory a, uint256 cap)
        internal
    {
        if (vault.seedMaxPerRound(safe, a.asset) == cap) {
            console2.log("TestnetSafe: seed already authorized for", a.symbol, cap);
            return;
        }
        _exec(safe, owner, address(vault), 0, abi.encodeCall(LuckyVault.authorizeSeed, (a.asset, cap)));
        console2.log("TestnetSafe: authorized seed for", a.symbol, cap);
        if (!a.native) {
            console2.log("TestnetSafe: ERC-20 seed balance for", a.symbol, "is deposited by hand (approve, deposit)");
        }
    }

    function _requireTestnet() internal view {
        require(
            block.chainid == BSC_TESTNET || block.chainid == ANVIL,
            string.concat(
                "TestnetSafe: chain ",
                vm.toString(block.chainid),
                " is not BSC testnet (97); mainnet Safes are created in the Safe interface (SPEC 10.5)"
            )
        );
    }

    /// @dev What the runbook tells the operator to check by hand on mainnet, done here on every run.
    function _verifySafe(address safe, address owner) internal view {
        require(safe.code.length > 0, "TestnetSafe: the Safe has no code on this chain");
        ISafe s = ISafe(safe);
        require(
            DeploymentLib.eq(s.VERSION(), SAFE_VERSION),
            string.concat("TestnetSafe: Safe reports VERSION() ", s.VERSION(), ", expected 1.4.1")
        );
        address[] memory owners = s.getOwners();
        require(owners.length == 1 && owners[0] == owner, "TestnetSafe: the broadcaster is not the sole Safe owner");
        require(s.getThreshold() == 1, "TestnetSafe: Safe threshold is not 1");
        (address[] memory modules,) = s.getModulesPaginated(address(1), 10);
        require(modules.length == 0, "TestnetSafe: the Safe has a module enabled");
    }

    function _acceptOwnership(
        address safe,
        address owner,
        address target,
        address currentOwner,
        address pendingOwner,
        string memory label
    ) internal {
        if (currentOwner == safe) {
            console2.log("TestnetSafe: ownership already accepted on", label);
            return;
        }
        require(
            pendingOwner == safe,
            string.concat("TestnetSafe: ", label, " ownership is not pending at the Safe; run Configure first")
        );
        _exec(safe, owner, target, 0, abi.encodeWithSignature("acceptOwnership()"));
        console2.log("TestnetSafe: accepted ownership of", label);
    }

    /// @dev One Safe transaction with a pre-validated signature: `v == 1` and `r == owner` means the Safe checks
    ///      that `msg.sender` is that owner and needs no ECDSA at all, so the operator's ordinary signer flags are
    ///      the whole signing flow. `safeTxGas == 0 && gasPrice == 0` makes the Safe revert (GS013) when the inner
    ///      call fails, so a failed step stops the run instead of being swallowed.
    function _exec(address safe, address owner, address to, uint256 value, bytes memory data) internal {
        bytes memory signature = abi.encodePacked(bytes32(uint256(uint160(owner))), bytes32(0), uint8(1));
        bool ok = ISafe(safe)
            .execTransaction(to, value, data, OPERATION_CALL, 0, 0, 0, address(0), payable(address(0)), signature);
        require(ok, "TestnetSafe: Safe transaction failed");
    }
}
