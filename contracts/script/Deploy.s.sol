// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {KIND_COUNT} from "../src/Types.sol";
import {LuckyDraw} from "../src/LuckyDraw.sol";
import {LuckyVault} from "../src/LuckyVault.sol";
import {DeploymentLib} from "./DeploymentLib.sol";
import {DeploymentScript} from "./DeploymentScript.sol";

/// @title DeployBase
/// @notice Deploys the Vault/Draw pair from a deployment plan and writes the first manifest (SPEC §12, §14, §15).
/// @dev The logic lives in an abstract base so `DeployLocal` runs exactly these code paths against its mocks instead
///      of duplicating them. Everything that touches the chain happens inside one broadcast from one sender: the
///      operator that will hold ownership until the multisig accepts it (SPEC §2 "Owner authority uses two-step
///      transfer"). No key material is read here; `forge script --unlocked` or the operator's signer supplies it.
abstract contract DeployBase is DeploymentScript {
    /// @notice Deploys Vault and Draw from `plan` and returns the manifest that records them.
    /// @dev Order matters: the coordinator pre-checks run before anything is deployed, so a wrong chain or an
    ///      unusable coordinator costs no gas and leaves no half-deployment behind (SPEC §15 "A chain/subscription
    ///      mismatch, unsupported feed or missing external gate fails release").
    /// @param plan The parsed deployment plan.
    /// @param broadcaster The deploying operator address; becomes the initial owner of both contracts.
    /// @return manifest The manifest, already written to its canonical path.
    /// @return vault The deployed Vault.
    /// @return draw The deployed Draw.
    function _deployFromPlan(DeploymentLib.Manifest memory plan, address broadcaster)
        internal
        returns (DeploymentLib.Manifest memory manifest, LuckyVault vault, LuckyDraw draw)
    {
        _preflight(plan, broadcaster);

        vm.startBroadcast(broadcaster);
        vault = new LuckyVault(broadcaster);
        uint256 vaultBlock = block.number;
        draw = new LuckyDraw(
            address(vault),
            plan.vrf.coordinator,
            plan.vrf.subscriptionId,
            plan.vrf.keyHash,
            uint16(plan.vrf.requestConfirmations),
            uint32(plan.vrf.callbackGasLimit),
            plan.vrf.maxRequestCostNative,
            plan.ownership.feeAccount,
            broadcaster
        );
        vault.setDraw(address(draw));
        vm.stopBroadcast();

        // Binding is the one irreversible step of this script (SPEC §4.1: assigned once, no replacement).
        require(address(draw.VAULT()) == address(vault), "Deploy: Draw.VAULT() is not the deployed Vault");
        require(vault.draw() == address(draw), "Deploy: Vault.draw() is not the deployed Draw");
        require(draw.SUBSCRIPTION_ID() == plan.vrf.subscriptionId, "Deploy: subscription id mismatch");
        require(draw.KEY_HASH() == plan.vrf.keyHash, "Deploy: key hash mismatch");
        require(draw.REQUEST_CONFIRMATIONS() == plan.vrf.requestConfirmations, "Deploy: confirmations mismatch");
        require(draw.CALLBACK_GAS_LIMIT() == plan.vrf.callbackGasLimit, "Deploy: callback gas limit mismatch");
        require(draw.MAX_REQUEST_COST_NATIVE() == plan.vrf.maxRequestCostNative, "Deploy: max request cost mismatch");
        require(address(draw.VRF_COORDINATOR()) == plan.vrf.coordinator, "Deploy: coordinator mismatch");
        require(draw.feeAccount() == plan.ownership.feeAccount, "Deploy: fee account mismatch");
        require(vault.owner() == broadcaster && draw.owner() == broadcaster, "Deploy: initial owner mismatch");

        manifest = plan;
        manifest.schemaVersion = DeploymentLib.SCHEMA_VERSION;
        manifest.deploymentId = DeploymentLib.deploymentId(block.chainid, address(draw));
        manifest.createdAtUtc = DeploymentLib.utcTimestamp(block.timestamp);
        // Lower bound for log scanning: a broadcast mines the creation one or more blocks after the simulation
        // block, so the operator may raise this to the receipt's block, never lower it (SPEC §10.3 indexer scan).
        manifest.chain.startBlock = vaultBlock;
        manifest.toolchain = DeploymentLib.Toolchain({
            foundry: DeploymentLib.FOUNDRY_VERSION,
            solc: DeploymentLib.SOLC_VERSION,
            evmVersion: DeploymentLib.EVM_VERSION,
            optimizer: true,
            optimizerRuns: DeploymentLib.OPTIMIZER_RUNS,
            viaIr: true,
            bytecodeHash: DeploymentLib.BYTECODE_HASH
        });
        manifest.vault = DeploymentLib.ContractRecord({
            addr: address(vault),
            codeHash: address(vault).codehash,
            deployBlock: vaultBlock,
            deployTx: bytes32(0), // a script never sees its own transaction hash; the operator fills it from the receipt
            owner: vault.owner(),
            pendingOwner: vault.pendingOwner()
        });
        manifest.draw = DeploymentLib.ContractRecord({
            addr: address(draw),
            codeHash: address(draw).codehash,
            deployBlock: block.number,
            deployTx: bytes32(0),
            owner: draw.owner(),
            pendingOwner: draw.pendingOwner()
        });
        manifest.drawConstructor = DeploymentLib.DrawConstructor({
            vault: address(vault),
            coordinator: plan.vrf.coordinator,
            subscriptionId: plan.vrf.subscriptionId,
            keyHash: plan.vrf.keyHash,
            requestConfirmations: plan.vrf.requestConfirmations,
            callbackGasLimit: plan.vrf.callbackGasLimit,
            maxRequestCostNative: plan.vrf.maxRequestCostNative,
            feeAccount: plan.ownership.feeAccount,
            initialOwner: broadcaster
        });
        manifest.vrf.consumerRegistered = DeploymentLib.isConsumer(plan.vrf, address(draw));
        manifest.vrf.subscriptionOwner = DeploymentLib.subscriptionOwner(plan.vrf);
        manifest.ownership.ownershipAccepted = false;
        // Nothing is listed and no pool exists yet, so the facts are zeroed. `depositsEnabled`, `pool.enabled`,
        // `pool.seedAmount` and `pool.targetsUsd` stay as the plan asked for them: they are the configuration
        // `Configure` must still apply, and they become recorded facts only once it has run.
        for (uint256 i = 0; i < manifest.assets.length; ++i) {
            manifest.assets[i].listed = false;
            manifest.assets[i].pool.poolId = 0;
            for (uint256 k = 0; k < KIND_COUNT; ++k) {
                manifest.assets[i].pool.firstRoundIds[k] = 0;
            }
        }

        string memory path = DeploymentLib.writeManifest(manifest, _deploymentsDir());
        console2.log("Deploy: vault  ", address(vault));
        console2.log("Deploy: draw   ", address(draw));
        console2.log("Deploy: id     ", manifest.deploymentId);
        console2.log("Deploy: manifest", path);
        console2.log("Deploy: next   ", "run Configure.s.sol with LUCKYDRAW_MANIFEST set to that path");
    }

    /// @notice Every check that must pass before a single byte is deployed (SPEC §7.1, §15).
    /// @param plan The parsed plan.
    /// @param broadcaster The deploying operator address.
    function _preflight(DeploymentLib.Manifest memory plan, address broadcaster) internal view {
        require(
            block.chainid == plan.chain.chainId,
            string.concat(
                "Deploy: chain id mismatch: connected to ",
                vm.toString(block.chainid),
                " but the plan targets ",
                vm.toString(plan.chain.chainId)
            )
        );
        require(broadcaster != address(0), "Deploy: no broadcaster; pass --sender");
        require(plan.ownership.finalOwner != address(0), "Deploy: ownership.finalOwner is required");
        // The privileged roles are checked before the environment rules: an operator who has to fix a plan should
        // hear about an unusable owner, treasury or seed account first, whatever else is also wrong with it.
        _requireSafeRoles(plan);
        require(
            DeploymentLib.eq(plan.environment, "local") || !DeploymentLib.referencesMocks(plan),
            "Deploy: a non-local plan may reference no mock artifact (SPEC 12)"
        );
        _requireEnvironmentMatchesChain(plan);
        require(plan.vrf.requestConfirmations <= type(uint16).max, "Deploy: requestConfirmations out of range");
        require(plan.vrf.callbackGasLimit <= type(uint32).max, "Deploy: callbackGasLimit out of range");
        require(plan.vrf.numWords == DeploymentLib.NUM_WORDS, "Deploy: SPEC 7.1 fixes numWords at 2");
        require(plan.vrf.maxRequestCostNative > 0, "Deploy: maxRequestCostNative must be nonzero");

        uint256 derived = DeploymentLib.derivedMaxRequestCost(plan.vrf);
        if (derived != 0) {
            require(
                plan.vrf.maxRequestCostNative >= derived,
                string.concat(
                    "Deploy: maxRequestCostNative ",
                    vm.toString(plan.vrf.maxRequestCostNative),
                    " is below its own derivation ",
                    vm.toString(derived)
                )
            );
        }
        require(
            plan.vrf.lowFundingThresholdNative >= plan.vrf.maxRequestCostNative,
            "Deploy: lowFundingThresholdNative must cover at least one request (SPEC 6.2)"
        );

        _requireCoordinatorViews(plan.vrf);

        for (uint256 i = 0; i < plan.assets.length; ++i) {
            DeploymentLib.AssetSpec memory a = plan.assets[i];
            require(a.decimals <= 18, string.concat("Deploy: asset decimals out of range: ", a.symbol));
            require(!a.native || a.decimals == 18, "Deploy: native BNB must declare 18 decimals");
            require(a.price.feed.code.length > 0, string.concat("Deploy: price feed has no code: ", a.symbol));
            require(a.asset != plan.vrf.coordinator, "Deploy: the coordinator cannot be a listed asset");
        }
    }

    /// @notice Asserts the declared environment is the chain the plan is actually being deployed to.
    /// @dev Mirrors the configuration validator's rule E1 ("`environment` and `chainId` agree; mainnet is 56, testnet
    ///      is 97", config/README.md) so a plan cannot reach a chain whose rules it was not written for: `local` is
    ///      the only environment allowed to carry mocks, and only chain 31337 is local.
    /// @param plan The parsed plan.
    function _requireEnvironmentMatchesChain(DeploymentLib.Manifest memory plan) internal view {
        uint256 expected = DeploymentLib.eq(plan.environment, "local")
            ? 31337
            : DeploymentLib.eq(plan.environment, "testnet") ? 97 : 56;
        require(
            block.chainid == expected,
            string.concat(
                "Deploy: environment '",
                plan.environment,
                "' requires chain id ",
                vm.toString(expected),
                " but this is chain ",
                vm.toString(block.chainid),
                " (config/README.md E1)"
            )
        );
    }

    /// @notice Asserts the three privileged roles are contracts off `local` (SPEC §10.5, §12.1).
    /// @dev SPEC §12.1 requires a Safe for the owner, treasury and seed roles from testnet onwards, and §10.5 fixes
    ///      what that Safe must be. `feeAccount` is frozen into every round at creation (SPEC §5.2) and cannot be
    ///      changed afterwards, so an address pasted from another chain would send the fee of every round of every
    ///      pool to an account nobody controls. Requiring code catches exactly that: a Safe has code on its own
    ///      chain and an externally owned account never does.
    /// @param plan The parsed plan.
    function _requireSafeRoles(DeploymentLib.Manifest memory plan) internal view {
        if (DeploymentLib.eq(plan.environment, "local")) return;
        require(
            plan.ownership.finalOwner.code.length > 0,
            "Deploy: ownership.finalOwner has no code; the owner role is a Safe outside local (SPEC 10.5, 12.1)"
        );
        require(
            plan.ownership.feeAccount.code.length > 0,
            "Deploy: ownership.feeAccount has no code; the treasury role is a Safe outside local (SPEC 10.5, 12.1)"
        );
        require(
            plan.ownership.seedAccount.code.length > 0,
            "Deploy: ownership.seedAccount has no code; the seed role is a Safe outside local (SPEC 10.5, 12.1)"
        );
    }

    /// @notice Asserts the coordinator exposes the two views the Draw's §6.2 pre-checks call.
    /// @dev SPEC §15 "VRF": the deploy script asserts that the coordinator exposes `s_provingKeys(bytes32)` and
    ///      reverts otherwise, "so the pre-check can never turn into a permanent revert". `getSubscription` is
    ///      checked for the same reason: `requestDraw` reads it on every request.
    /// @param v The VRF record of the plan.
    function _requireCoordinatorViews(DeploymentLib.VrfSpec memory v) internal view {
        require(v.coordinator != address(0), "Deploy: vrf.coordinator is required");
        require(
            v.coordinator.code.length > 0,
            string.concat("Deploy: no contract at the VRF coordinator address ", vm.toString(v.coordinator))
        );

        (bool exposed, bool laneRegistered) = DeploymentLib.exposesProvingKeys(v);
        require(
            exposed, "Deploy: coordinator does not expose s_provingKeys(bytes32) returns (bool,uint64) (SPEC 15 VRF)"
        );
        require(
            DeploymentLib.exposesGetSubscription(v),
            "Deploy: coordinator does not expose getSubscription(uint256) (SPEC 6.2)"
        );

        // Not fatal: the lane and the consumer registration are operator actions that may follow the deployment.
        // `Configure` refuses to create a pool until the consumer is registered and the subscription is funded.
        if (!laneRegistered) {
            console2.log("Deploy: WARNING key hash is not registered on this coordinator:", vm.toString(v.keyHash));
        }
    }
}

/// @notice Operator entry point: `LUCKYDRAW_PLAN=<plan.json> forge script script/Deploy.s.sol:Deploy ...`.
/// @dev Deploys and binds only. Listing, pools, seeds, targets and the ownership handover are `Configure`'s job, so
///      a failed configuration never has to be untangled from a failed deployment.
contract Deploy is DeployBase {
    /// @notice Reads the plan named by `LUCKYDRAW_PLAN`, deploys, and writes the manifest.
    /// @return path The manifest path.
    function run() external returns (string memory path) {
        return deployPlanAt(vm.envString("LUCKYDRAW_PLAN"), msg.sender);
    }

    /// @notice Deploys from an explicit plan path on behalf of an explicit broadcaster.
    /// @dev Separated from `run` so the in-process script tests drive the same code with their own fixtures.
    /// @param planPath The plan document.
    /// @param broadcaster The deploying operator address.
    /// @return path The manifest path.
    function deployPlanAt(string memory planPath, address broadcaster) public returns (string memory path) {
        DeploymentLib.Manifest memory plan = DeploymentLib.readDocument(planPath);
        (DeploymentLib.Manifest memory manifest,,) = _deployFromPlan(plan, broadcaster);
        return DeploymentLib.manifestPath(_deploymentsDir(), manifest.chain.chainId, manifest.draw.addr);
    }
}
