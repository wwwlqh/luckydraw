// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {ILuckyDraw} from "../src/interfaces/ILuckyDraw.sol";
import {ILuckyVault} from "../src/interfaces/ILuckyVault.sol";
import {LuckyDraw} from "../src/LuckyDraw.sol";
import {LuckyVault} from "../src/LuckyVault.sol";
import {KIND_COUNT, Kind, PricingConfig} from "../src/Types.sol";
import {DeploymentLib} from "./DeploymentLib.sol";
import {DeploymentScript} from "./DeploymentScript.sol";
import {DeploymentHistory} from "./DeploymentHistory.sol";

/// @title VerifyBase
/// @notice Read-only comparison of a manifest against the chain it claims to describe (SPEC §15).
/// @dev Never writes, never broadcasts, never needs an owner key: anyone with an RPC endpoint can reproduce the
///      result. Every comparison prints one line, and the run reverts at the end if any of them failed, so
///      `forge script` exits non-zero and CI or a release gate can depend on it.
///
///      This is the "verified deployment and manifest" evidence of SPEC §14 (Testnet integration) and the
///      "Validate manifest chain/address agreement before any UI signs" rule of §15: the client, indexer and keeper
///      all trust the manifest, so the manifest must be provably the chain's own state.
abstract contract VerifyBase is DeploymentScript, DeploymentHistory {
    /// @notice Number of comparisons made in the current run.
    uint256 internal checksRun;
    /// @notice Number of comparisons that failed in the current run.
    uint256 internal checksFailed;

    /// @notice Compares every recorded fact in `m` with live chain state.
    /// @param m The manifest to verify.
    /// @return failed The number of failed checks; zero means the deployment matches its manifest.
    function _verifyManifest(DeploymentLib.Manifest memory m) internal returns (uint256 failed) {
        checksRun = 0;
        checksFailed = 0;

        _checkUint(block.chainid, m.chain.chainId, "chain.chainId matches the connected chain");
        _check(m.schemaVersion == DeploymentLib.SCHEMA_VERSION, "schemaVersion is supported");
        _check(
            DeploymentLib.eq(m.deploymentId, DeploymentLib.deploymentId(m.chain.chainId, m.draw.addr)),
            "deploymentId is ${chainId}:${lowercase draw address}"
        );
        _checkToolchain(m.toolchain);
        _checkMockPolicy(m);

        LuckyVault vault = LuckyVault(m.vault.addr);
        LuckyDraw draw = LuckyDraw(m.draw.addr);
        _check(m.vault.addr.code.length > 0, "Vault has deployed code");
        _check(m.draw.addr.code.length > 0, "Draw has deployed code");
        _checkB32(m.vault.addr.codehash, m.vault.codeHash, "Vault extcodehash matches the manifest");
        _checkB32(m.draw.addr.codehash, m.draw.codeHash, "Draw extcodehash matches the manifest");
        uint256 vaultBlock = _creationBlock(m.vault.addr, m.vault.deployTx);
        uint256 drawBlock = _creationBlock(m.draw.addr, m.draw.deployTx);
        _checkUint(m.vault.deployBlock, vaultBlock, "Vault deployBlock matches the canonical creation receipt");
        _checkUint(m.draw.deployBlock, drawBlock, "Draw deployBlock matches the canonical creation receipt");
        _check(
            m.chain.startBlock <= vaultBlock && m.chain.startBlock <= drawBlock,
            "chain.startBlock is at or before both deployment blocks"
        );

        _checkAddr(vault.draw(), m.draw.addr, "Vault.draw() is the manifest Draw");
        _checkAddr(address(draw.VAULT()), m.vault.addr, "Draw.VAULT() is the manifest Vault");

        _checkImmutables(draw, m);
        _checkOwners(vault, draw, m);
        _checkVrf(m);

        // The asset loop below can only look at pools the manifest already knows about. A pool the manifest does not
        // list is invisible to it, and a pool is the one thing the owner can add that changes what the deployment
        // plays (SPEC §8.1), so the count itself is compared.
        _checkUint(draw.poolCount(), m.assets.length, "poolCount equals the number of assets the manifest records");

        for (uint256 i = 0; i < m.assets.length; ++i) {
            _checkAsset(vault, draw, m.assets[i], m.ownership.seedAccount);
        }

        console2.log("Verify: checks run", checksRun);
        console2.log("Verify: checks failed", checksFailed);
        return checksFailed;
    }

    /// @dev The manifest must record the pins the bytecode was actually built with (SPEC §12). Solidity cannot read
    ///      its own compiler settings, so the pins are compiled in from `DeploymentLib` and the `pragma` above fixes
    ///      the solc version; CI compares those constants with `foundry.toml`.
    function _checkToolchain(DeploymentLib.Toolchain memory t) private {
        _check(DeploymentLib.eq(t.foundry, DeploymentLib.FOUNDRY_VERSION), "toolchain.foundry pin");
        _check(DeploymentLib.eq(t.solc, DeploymentLib.SOLC_VERSION), "toolchain.solc pin");
        _check(DeploymentLib.eq(t.evmVersion, DeploymentLib.EVM_VERSION), "toolchain.evmVersion pin");
        _check(t.optimizer && t.viaIr, "toolchain records optimizer and via_ir");
        _check(t.optimizerRuns == DeploymentLib.OPTIMIZER_RUNS, "toolchain.optimizerRuns pin");
        _check(DeploymentLib.eq(t.bytecodeHash, DeploymentLib.BYTECODE_HASH), "toolchain.bytecodeHash pin");
    }

    /// @dev SPEC §12: "a mainnet manifest may reference no mock artifact"; §15: a mismatch is never silently
    ///      replaced with mocks. Enforced for every environment other than `local`.
    function _checkMockPolicy(DeploymentLib.Manifest memory m) private {
        bool isLocal = DeploymentLib.eq(m.environment, "local");
        if (isLocal) {
            _check(m.mocks.length > 0, "local manifest names the mock artifacts it uses");
        } else {
            _check(
                !DeploymentLib.referencesMocks(m),
                string.concat("environment '", m.environment, "' references no mock artifact")
            );
        }
    }

    /// @dev Every constructor-fixed value of the Draw (SPEC §7.1: there is no setter for any of them).
    function _checkImmutables(LuckyDraw draw, DeploymentLib.Manifest memory m) private {
        _checkAddr(address(draw.VRF_COORDINATOR()), m.vrf.coordinator, "Draw.VRF_COORDINATOR");
        _checkUint(draw.SUBSCRIPTION_ID(), m.vrf.subscriptionId, "Draw.SUBSCRIPTION_ID");
        _checkB32(draw.KEY_HASH(), m.vrf.keyHash, "Draw.KEY_HASH");
        _checkUint(draw.REQUEST_CONFIRMATIONS(), m.vrf.requestConfirmations, "Draw.REQUEST_CONFIRMATIONS");
        _checkUint(draw.CALLBACK_GAS_LIMIT(), m.vrf.callbackGasLimit, "Draw.CALLBACK_GAS_LIMIT");
        _checkUint(draw.MAX_REQUEST_COST_NATIVE(), m.vrf.maxRequestCostNative, "Draw.MAX_REQUEST_COST_NATIVE");
        // Compared with the deployed Draw rather than with the library constant: the constant says what this
        // repository builds, the Draw says what the manifest's users will actually be paid out from (SPEC §7.1).
        _checkUint(draw.NUM_WORDS(), m.vrf.numWords, "Draw.NUM_WORDS matches vrf.numWords (SPEC 7.1)");
        _checkAddr(draw.feeAccount(), m.ownership.feeAccount, "Draw.feeAccount");
        _checkAddr(draw.getSeedAccount(), m.ownership.seedAccount, "Draw.getSeedAccount");

        _checkAddr(m.drawConstructor.vault, m.vault.addr, "constructorArgs.vault");
        _checkAddr(m.drawConstructor.coordinator, m.vrf.coordinator, "constructorArgs.coordinator");
        _checkUint(m.drawConstructor.subscriptionId, m.vrf.subscriptionId, "constructorArgs.subscriptionId");
        _checkB32(m.drawConstructor.keyHash, m.vrf.keyHash, "constructorArgs.keyHash");
        _checkUint(
            m.drawConstructor.requestConfirmations, m.vrf.requestConfirmations, "constructorArgs.requestConfirmations"
        );
        _checkUint(m.drawConstructor.callbackGasLimit, m.vrf.callbackGasLimit, "constructorArgs.callbackGasLimit");
        _checkUint(
            m.drawConstructor.maxRequestCostNative, m.vrf.maxRequestCostNative, "constructorArgs.maxRequestCostNative"
        );
        _checkAddr(m.drawConstructor.feeAccount, m.ownership.feeAccount, "constructorArgs.feeAccount");
        _check(m.drawConstructor.initialOwner != address(0), "constructorArgs.initialOwner is recorded");
    }

    /// @dev Two-step ownership: until the multisig accepts, the owner is the deployer and the pending owner is the
    ///      multisig (SPEC §2, §8.1, D6).
    function _checkOwners(LuckyVault vault, LuckyDraw draw, DeploymentLib.Manifest memory m) private {
        _checkAddr(vault.owner(), m.vault.owner, "Vault.owner matches the manifest");
        _checkAddr(vault.pendingOwner(), m.vault.pendingOwner, "Vault.pendingOwner matches the manifest");
        _checkAddr(draw.owner(), m.draw.owner, "Draw.owner matches the manifest");
        _checkAddr(draw.pendingOwner(), m.draw.pendingOwner, "Draw.pendingOwner matches the manifest");

        address finalOwner = m.ownership.finalOwner;
        bool accepted = vault.owner() == finalOwner && draw.owner() == finalOwner;
        _check(accepted == m.ownership.ownershipAccepted, "ownership.ownershipAccepted matches the chain");
        if (!accepted) {
            _check(
                vault.pendingOwner() == finalOwner && draw.pendingOwner() == finalOwner,
                "ownership is pending at ownership.finalOwner on both contracts"
            );
        }

        // SPEC §10.5 and §12.1: from testnet onwards each privileged role is a Safe, and `feeAccount` in particular
        // is frozen into every round at creation. An address with no code on this chain is not the Safe the operator
        // meant. Local runs use labeled anvil accounts and are exempt, which is why these three are conditional.
        if (!DeploymentLib.eq(m.environment, "local")) {
            _check(finalOwner.code.length > 0, "ownership.finalOwner has deployed code (a Safe, SPEC 10.5, 12.1)");
            _check(
                m.ownership.feeAccount.code.length > 0,
                "ownership.feeAccount has deployed code (a Safe, SPEC 10.5, 12.1)"
            );
            _check(
                m.ownership.seedAccount.code.length > 0,
                "ownership.seedAccount has deployed code (a Safe, SPEC 10.5, 12.1)"
            );
        }
    }

    /// @dev The VRF record of SPEC §15, including the pre-check getters the Draw depends on for its lifetime.
    function _checkVrf(DeploymentLib.Manifest memory m) private {
        _check(m.vrf.coordinator.code.length > 0, "the VRF coordinator has deployed code");

        (bool exposed, bool laneRegistered) = DeploymentLib.exposesProvingKeys(m.vrf);
        _check(exposed, "coordinator exposes s_provingKeys(bytes32) (SPEC 15 VRF)");
        _check(DeploymentLib.exposesGetSubscription(m.vrf), "coordinator exposes getSubscription(uint256)");
        _check(laneRegistered, "the gas lane (key hash) is registered on the coordinator");

        if (exposed) {
            _check(
                DeploymentLib.isConsumer(m.vrf, m.draw.addr) == m.vrf.consumerRegistered,
                "vrf.consumerRegistered matches the coordinator"
            );
            _check(DeploymentLib.isConsumer(m.vrf, m.draw.addr), "the Draw is a registered consumer (SPEC 7.3)");
            _checkAddr(DeploymentLib.subscriptionOwner(m.vrf), m.vrf.subscriptionOwner, "vrf.subscriptionOwner matches");
            uint256 balance = DeploymentLib.subscriptionNativeBalance(m.vrf);
            _check(
                balance >= m.vrf.lowFundingThresholdNative,
                string.concat(
                    "subscription native balance ",
                    vm.toString(balance),
                    " is at or above the low-funding threshold ",
                    vm.toString(m.vrf.lowFundingThresholdNative)
                )
            );
        }

        uint256 derived = DeploymentLib.derivedMaxRequestCost(m.vrf);
        _check(
            derived == 0 || m.vrf.maxRequestCostNative >= derived,
            "maxRequestCostNative covers its own recorded derivation (SPEC 7.1)"
        );
        _check(
            m.vrf.lowFundingThresholdNative >= m.vrf.maxRequestCostNative,
            "lowFundingThresholdNative covers at least one request (SPEC 6.2)"
        );
    }

    /// @dev One asset: its Vault listing, its pool and the terms the pool's first rounds froze.
    function _checkAsset(LuckyVault vault, LuckyDraw draw, DeploymentLib.AssetSpec memory a, address seedAccount)
        private
    {
        string memory tag = string.concat("[", a.symbol, "] ");

        ILuckyVault.AssetRecord memory record = vault.getAsset(a.asset);
        _check(record.listed == a.listed, string.concat(tag, "Vault listing flag"));
        _check(record.tokenDecimals == a.decimals, string.concat(tag, "Vault listed decimals"));
        _check(record.depositsEnabled == a.depositsEnabled, string.concat(tag, "Vault depositsEnabled"));
        _check((a.asset == address(0)) == a.native, string.concat(tag, "native flag matches the address"));

        if (a.pool.poolId == 0) {
            _check(false, string.concat(tag, "pool identifier is recorded"));
            return;
        }
        _check(a.pool.poolId <= draw.poolCount(), string.concat(tag, "pool exists"));

        ILuckyDraw.PoolView memory pool = draw.getPool(a.pool.poolId);
        _checkAddr(pool.asset, a.asset, string.concat(tag, "pool asset"));
        _check(pool.enabled == a.pool.enabled, string.concat(tag, "pool enabled flag"));
        _checkUint(pool.seedAmount, a.pool.seedAmount, string.concat(tag, "pool seed amount"));
        for (uint256 k = 0; k < KIND_COUNT; ++k) {
            _checkUint(
                pool.targetUsd[k], a.pool.targetsUsd[k], string.concat(tag, "target ", DeploymentLib.kindName(Kind(k)))
            );
        }
        _checkPricing(pool.nextPricing, DeploymentLib.pricingOf(a), string.concat(tag, "pool pricing config"));

        uint256 cap = vault.seedMaxPerRound(seedAccount, a.asset);
        _check(
            DeploymentLib.eq(a.pool.seedAuthorizedMaxPerRound, cap == 0 ? "" : vm.toString(cap)),
            string.concat(tag, "recorded seed cap matches Vault.seedMaxPerRound for this asset")
        );

        for (uint256 k = 0; k < KIND_COUNT; ++k) {
            uint256 roundId = a.pool.firstRoundIds[k];
            string memory rtag = string.concat(tag, DeploymentLib.kindName(Kind(k)), " first round ");
            if (roundId == 0) {
                _check(false, string.concat(rtag, "is recorded"));
                continue;
            }
            ILuckyDraw.RoundView memory round = draw.getRound(roundId);
            _checkUint(round.poolId, a.pool.poolId, string.concat(rtag, "belongs to the pool"));
            _check(round.kind == Kind(k), string.concat(rtag, "has the recorded kind"));
            _checkAddr(round.asset, a.asset, string.concat(rtag, "asset"));
            _checkUint(round.sequence, 1, string.concat(rtag, "is the first of its sequence"));
            // The frozen terms of a round never change (D5); a later setNextPricing needs a manifest update.
            _checkPricing(round.pricing, DeploymentLib.pricingOf(a), string.concat(rtag, "frozen pricing config"));
            console2.log(
                string.concat(rtag, "frozen target USD"), uint256(round.targetUsd), "closesAt", uint256(round.closesAt)
            );
        }
    }

    function _checkPricing(PricingConfig memory got, PricingConfig memory want, string memory label) private {
        _checkAddr(got.feed, want.feed, string.concat(label, ": feed"));
        _checkUint(got.feedDecimals, want.feedDecimals, string.concat(label, ": feedDecimals"));
        _checkUint(got.maxPriceAge, want.maxPriceAge, string.concat(label, ": maxPriceAge"));
        _check(got.referenceKind == want.referenceKind, string.concat(label, ": referenceKind"));
        _check(got.minAnswer == want.minAnswer, string.concat(label, ": minAnswer"));
        _check(got.maxAnswer == want.maxAnswer, string.concat(label, ": maxAnswer"));
    }

    /// @notice Reads the manifest at `path` and verifies it, returning the number of failed checks.
    /// @dev Public so the in-process script tests can assert on the count instead of on a revert.
    /// @param path The manifest document.
    /// @return failed The number of failed checks.
    function verifyManifestAt(string memory path) public returns (uint256 failed) {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        console2.log("Verify: manifest", path);
        console2.log("Verify: deployment", m.deploymentId);
        return _verifyManifest(m);
    }

    // ---- check primitives ----

    function _check(bool ok, string memory label) internal {
        ++checksRun;
        if (!ok) ++checksFailed;
        console2.log(string.concat(ok ? "  PASS  " : "  FAIL  ", label));
    }

    function _checkAddr(address got, address want, string memory label) internal {
        bool ok = got == want;
        _check(ok, label);
        if (!ok) {
            console2.log(string.concat("        expected ", vm.toString(want), " got ", vm.toString(got)));
        }
    }

    function _checkUint(uint256 got, uint256 want, string memory label) internal {
        bool ok = got == want;
        _check(ok, label);
        if (!ok) {
            console2.log(string.concat("        expected ", vm.toString(want), " got ", vm.toString(got)));
        }
    }

    function _checkB32(bytes32 got, bytes32 want, string memory label) internal {
        bool ok = got == want;
        _check(ok, label);
        if (!ok) {
            console2.log(string.concat("        expected ", vm.toString(want), " got ", vm.toString(got)));
        }
    }
}

/// @notice Operator entry point: `LUCKYDRAW_MANIFEST=<manifest.json> forge script script/Verify.s.sol:Verify`.
/// @dev Read-only; safe to run against any environment from any account, including none.
contract Verify is VerifyBase {
    /// @notice Verifies the manifest named by `LUCKYDRAW_MANIFEST` and reverts if any check failed.
    function run() external {
        string memory path = vm.envString("LUCKYDRAW_MANIFEST");
        uint256 failed = verifyManifestAt(path);
        require(failed == 0, string.concat("Verify: ", vm.toString(failed), " check(s) failed for ", path));
        console2.log("Verify: OK");
    }
}
