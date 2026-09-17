// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {ILuckyDraw} from "../src/interfaces/ILuckyDraw.sol";
import {ILuckyVault} from "../src/interfaces/ILuckyVault.sol";
import {LuckyDraw} from "../src/LuckyDraw.sol";
import {LuckyVault} from "../src/LuckyVault.sol";
import {KIND_COUNT, Kind} from "../src/Types.sol";
import {DeploymentLib} from "./DeploymentLib.sol";
import {DeploymentScript} from "./DeploymentScript.sol";

/// @title ConfigureBase
/// @notice Lists the manifest's assets, opens their pools and hands ownership to the final multisig (SPEC §8.1).
/// @dev Idempotent by construction: every step reads the live state first and is skipped when it already matches the
///      manifest, so a re-run after a partial failure resumes instead of duplicating. Nothing here is destructive --
///      there is no unlist, no pool removal and no way to reopen a round.
///
///      Ownership is deliberately the last step: once `transferOwnership` has run, the deploying operator can still
///      configure (the transfer is two-step and not yet accepted), but after acceptance every owner method belongs to
///      the multisig, which is the intended end state (SPEC §2, §14).
abstract contract ConfigureBase is DeploymentScript {
    /// @notice Applies the manifest's configuration to the deployed pair and returns the updated manifest.
    /// @param m The manifest produced by `Deploy`.
    /// @param broadcaster The operator address that currently owns both contracts.
    /// @return updated The manifest with pool ids, first round ids, listing flags and owner state filled in.
    function _configureFromManifest(DeploymentLib.Manifest memory m, address broadcaster)
        internal
        returns (DeploymentLib.Manifest memory updated)
    {
        require(
            block.chainid == m.chain.chainId,
            string.concat(
                "Configure: chain id mismatch: connected to ",
                vm.toString(block.chainid),
                " but the manifest targets ",
                vm.toString(m.chain.chainId)
            )
        );
        require(m.vault.addr != address(0) && m.draw.addr != address(0), "Configure: manifest has no deployed pair");

        LuckyVault vault = LuckyVault(m.vault.addr);
        LuckyDraw draw = LuckyDraw(m.draw.addr);
        require(m.vault.codeHash == address(vault).codehash, "Configure: Vault code hash differs from the manifest");
        require(m.draw.codeHash == address(draw).codehash, "Configure: Draw code hash differs from the manifest");
        require(vault.draw() == address(draw), "Configure: Vault is not bound to the manifest's Draw");
        require(address(draw.VAULT()) == address(vault), "Configure: Draw is not bound to the manifest's Vault");
        // `_requireVrfReady` asks the manifest's own VRF record whether a draw can ever be paid for, so the record
        // has to be the Draw's own constructor-fixed truth first. Without this, an edited subscription id points the
        // readiness check at a healthy subscription while the Draw requests from another one, and every pool this
        // run opens is a round that can never draw (SPEC §7.1: none of these has a setter).
        require(
            address(draw.VRF_COORDINATOR()) == m.vrf.coordinator, "Configure: vrf.coordinator differs from the Draw"
        );
        require(draw.SUBSCRIPTION_ID() == m.vrf.subscriptionId, "Configure: vrf.subscriptionId differs from the Draw");
        require(draw.KEY_HASH() == m.vrf.keyHash, "Configure: vrf.keyHash differs from the Draw");
        require(
            draw.MAX_REQUEST_COST_NATIVE() == m.vrf.maxRequestCostNative,
            "Configure: vrf.maxRequestCostNative differs from the Draw"
        );
        // SPEC §12: the mock policy is not the document's own word for it. `referencesMocks` also compares the
        // recorded addresses with the deployed code of this repository's mocks, so a cleared flag changes nothing.
        require(
            DeploymentLib.eq(m.environment, "local") || !DeploymentLib.referencesMocks(m),
            "Configure: a non-local manifest may reference no mock artifact (SPEC 12)"
        );

        vm.startBroadcast(broadcaster);

        for (uint256 i = 0; i < m.assets.length; ++i) {
            _configureAsset(m, i, vault, draw, broadcaster);
        }

        if (draw.getSeedAccount() != m.ownership.seedAccount) {
            _requireOwner(draw.owner(), broadcaster, "set the seed account");
            draw.setSeedAccount(m.ownership.seedAccount);
            console2.log("Configure: seed account set to", m.ownership.seedAccount);
        } else {
            console2.log("Configure: seed account already", m.ownership.seedAccount);
        }

        _transferOwnership(m, vault, draw, broadcaster);

        vm.stopBroadcast();

        m.vrf.consumerRegistered = DeploymentLib.isConsumer(m.vrf, address(draw));
        m.vrf.subscriptionOwner = DeploymentLib.subscriptionOwner(m.vrf);
        m.vault.owner = vault.owner();
        m.vault.pendingOwner = vault.pendingOwner();
        m.draw.owner = draw.owner();
        m.draw.pendingOwner = draw.pendingOwner();
        m.ownership.ownershipAccepted =
            vault.owner() == m.ownership.finalOwner && draw.owner() == m.ownership.finalOwner;

        string memory path = DeploymentLib.writeManifest(m, _deploymentsDir());
        console2.log("Configure: manifest", path);
        if (!m.ownership.ownershipAccepted) {
            console2.log("Configure: ownership pending at", m.ownership.finalOwner);
            console2.log("Configure: the final owner must call acceptOwnership() on both contracts (SPEC 2, 14)");
        }
        console2.log(
            "Configure: the seed account must call Vault.authorizeSeed(asset, cap) itself per asset before any seed entry"
        );
        return m;
    }

    /// @notice Lists one asset, enables deposits and opens its pool, skipping whatever is already in place.
    /// @param m The manifest, updated in place.
    /// @param i The asset index.
    /// @param vault The bound Vault.
    /// @param draw The bound Draw.
    /// @param broadcaster The operator address.
    function _configureAsset(
        DeploymentLib.Manifest memory m,
        uint256 i,
        LuckyVault vault,
        LuckyDraw draw,
        address broadcaster
    ) private {
        DeploymentLib.AssetSpec memory a = m.assets[i];
        ILuckyVault.AssetRecord memory record = vault.getAsset(a.asset);

        if (!record.listed) {
            _requireOwner(vault.owner(), broadcaster, string.concat("list ", a.symbol));
            vault.listAsset(a.asset, uint8(a.decimals));
            console2.log("Configure: listed", a.symbol, a.asset);
        } else {
            require(
                record.tokenDecimals == a.decimals,
                string.concat("Configure: ", a.symbol, " is listed with different decimals than the manifest")
            );
            console2.log("Configure: already listed, skipped", a.symbol);
        }
        m.assets[i].listed = true;

        if (record.depositsEnabled != a.depositsEnabled) {
            _requireOwner(vault.owner(), broadcaster, string.concat("set deposits for ", a.symbol));
            vault.setDepositsEnabled(a.asset, a.depositsEnabled);
            console2.log("Configure: depositsEnabled set", a.symbol, a.depositsEnabled);
        }

        uint256 poolId = _findPool(draw, a.asset);
        if (poolId == 0) {
            // SPEC §7.3/§15: the configure script asserts the consumer registration and the low-funding threshold
            // before addPool, so a pool can never go live against a subscription that cannot pay for a draw.
            _requireVrfReady(m.vrf, address(draw));
            _requireOwner(draw.owner(), broadcaster, string.concat("add the pool for ", a.symbol));
            poolId = draw.addPool(a.asset, DeploymentLib.pricingOf(a));
            for (uint256 k = 0; k < KIND_COUNT; ++k) {
                m.assets[i].pool.firstRoundIds[k] = draw.getCurrent(poolId, Kind(k));
            }
            console2.log("Configure: pool created", a.symbol, poolId);
        } else {
            console2.log("Configure: pool already exists, skipped", a.symbol, poolId);
            bool anyMissing;
            for (uint256 k = 0; k < KIND_COUNT; ++k) {
                if (m.assets[i].pool.firstRoundIds[k] == 0) anyMissing = true;
            }
            if (anyMissing) {
                m.assets[i].pool.firstRoundIds = _firstRounds(draw, poolId);
            }
        }
        m.assets[i].pool.poolId = poolId;

        ILuckyDraw.PoolView memory pool = draw.getPool(poolId);
        if (pool.seedAmount != a.pool.seedAmount) {
            _requireOwner(draw.owner(), broadcaster, string.concat("set the seed amount for ", a.symbol));
            draw.setSeedAmount(poolId, a.pool.seedAmount);
            console2.log("Configure: seedAmount set", a.symbol, a.pool.seedAmount);
        }

        for (uint256 k = 0; k < KIND_COUNT; ++k) {
            if (pool.targetUsd[k] == a.pool.targetsUsd[k]) continue;
            require(a.pool.targetsUsd[k] <= type(uint32).max, "Configure: targetUsd out of range");
            _requireOwner(draw.owner(), broadcaster, "set a target");
            draw.setTargetUsd(poolId, Kind(k), uint32(a.pool.targetsUsd[k]));
            console2.log("Configure: target set", DeploymentLib.kindName(Kind(k)), a.pool.targetsUsd[k]);
            // SPEC §8.1: "applies to rounds created afterwards; a round's own target never changes". The seven
            // rounds `addPool` just opened keep the contract defaults; the plan's target starts with the next one.
            console2.log("Configure: WARNING the first round of this kind keeps the default target");
        }

        if (pool.enabled != a.pool.enabled) {
            _requireOwner(draw.owner(), broadcaster, string.concat("set pool enablement for ", a.symbol));
            draw.setPoolEnabled(poolId, a.pool.enabled);
            console2.log("Configure: poolEnabled set", a.symbol, a.pool.enabled);
        }

        // The seed cap is the seed account's own consent, not an owner setting (SPEC §5.4, D9), and it is given
        // per asset in that asset's raw units: record what it actually authorized for this pool's asset so the
        // validator can check the seed amount against it and the operator can see a pool whose seeding will be
        // skipped for want of consent.
        uint256 cap = vault.seedMaxPerRound(m.ownership.seedAccount, a.asset);
        m.assets[i].pool.seedAuthorizedMaxPerRound = cap == 0 ? "" : vm.toString(cap);
        if (cap < a.pool.seedAmount) {
            console2.log("Configure: WARNING seed cap is below the seed amount for", a.symbol, cap);
            console2.log(
                "Configure: the seed account must call Vault.authorizeSeed for this asset with at least",
                a.pool.seedAmount
            );
        }
    }

    /// @notice Starts the two-step handover to the final owner, unless it is already started or complete.
    /// @param m The manifest.
    /// @param vault The Vault.
    /// @param draw The Draw.
    /// @param broadcaster The operator address.
    function _transferOwnership(DeploymentLib.Manifest memory m, LuckyVault vault, LuckyDraw draw, address broadcaster)
        private
    {
        address finalOwner = m.ownership.finalOwner;
        require(finalOwner != address(0), "Configure: ownership.finalOwner is required");
        if (finalOwner == broadcaster) {
            console2.log("Configure: final owner is the broadcaster; no transfer needed");
            return;
        }

        if (vault.owner() == broadcaster && vault.pendingOwner() != finalOwner) {
            vault.transferOwnership(finalOwner);
            console2.log("Configure: Vault ownership transfer started to", finalOwner);
        } else {
            console2.log("Configure: Vault ownership already pending or transferred, skipped");
        }
        if (draw.owner() == broadcaster && draw.pendingOwner() != finalOwner) {
            draw.transferOwnership(finalOwner);
            console2.log("Configure: Draw ownership transfer started to", finalOwner);
        } else {
            console2.log("Configure: Draw ownership already pending or transferred, skipped");
        }
    }

    /// @notice Asserts the VRF prerequisites of `addPool` (SPEC §7.3, §15).
    /// @param v The manifest's VRF record.
    /// @param drawAddr The Draw that must be a registered consumer.
    function _requireVrfReady(DeploymentLib.VrfSpec memory v, address drawAddr) internal view {
        require(
            DeploymentLib.isConsumer(v, drawAddr),
            string.concat(
                "Configure: the Draw is not a registered consumer of subscription ",
                vm.toString(v.subscriptionId),
                "; register it before addPool (SPEC 7.3)"
            )
        );
        uint256 balance = DeploymentLib.subscriptionNativeBalance(v);
        require(
            balance >= v.lowFundingThresholdNative,
            string.concat(
                "Configure: subscription native balance ",
                vm.toString(balance),
                " is below the low-funding threshold ",
                vm.toString(v.lowFundingThresholdNative),
                " (SPEC 6.2, 15)"
            )
        );
    }

    /// @notice The pool identifier that already plays `asset`, or zero.
    /// @param draw The Draw.
    /// @param asset The asset, or `address(0)` for native BNB.
    /// @return poolId The pool identifier, zero when the asset has no pool yet.
    function _findPool(LuckyDraw draw, address asset) internal view returns (uint256 poolId) {
        uint256 count = draw.poolCount();
        for (uint256 id = 1; id <= count; ++id) {
            if (draw.getPool(id).asset == asset) return id;
        }
        return 0;
    }

    /// @dev Original rounds remain readable after rollover. Do not infer ids from poolId: another pool's
    ///      successor rounds may have been created before this pool was added. This scan runs only on recovery.
    function _firstRounds(LuckyDraw draw, uint256 poolId) internal view returns (uint256[KIND_COUNT] memory ids) {
        uint256 count = draw.roundCount();
        uint256 found;
        for (uint256 id = 1; id <= count; ++id) {
            ILuckyDraw.RoundView memory round = draw.getRound(id);
            if (round.poolId != poolId || round.sequence != 1) continue;
            ids[uint256(round.kind)] = id;
            if (++found == KIND_COUNT) return ids;
        }
        revert("Configure: cannot recover the pool's original rounds");
    }

    /// @dev Fails with the action that could not be taken rather than with a bare `OwnableUnauthorizedAccount`.
    function _requireOwner(address owner, address broadcaster, string memory action) private pure {
        require(owner == broadcaster, string.concat("Configure: the broadcaster is not the owner and cannot ", action));
    }
}

/// @notice Operator entry point: `LUCKYDRAW_MANIFEST=<manifest.json> forge script script/Configure.s.sol:Configure`.
contract Configure is ConfigureBase {
    /// @notice Reads the manifest named by `LUCKYDRAW_MANIFEST`, applies the configuration and rewrites it.
    /// @return path The manifest path.
    function run() external returns (string memory path) {
        return configureAt(vm.envString("LUCKYDRAW_MANIFEST"), msg.sender);
    }

    /// @notice Configures from an explicit manifest path on behalf of an explicit broadcaster.
    /// @dev Separated from `run` so the in-process script tests drive the same code with their own fixtures.
    /// @param manifestPath The manifest document.
    /// @param broadcaster The operator address that owns both contracts.
    /// @return path The manifest path.
    function configureAt(string memory manifestPath, address broadcaster) public returns (string memory path) {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        _configureFromManifest(m, broadcaster);
        return manifestPath;
    }
}
