// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {LuckyDrawUpkeep} from "../src/LuckyDrawUpkeep.sol";
import {DeploymentLib} from "./DeploymentLib.sol";
import {DeploymentScript} from "./DeploymentScript.sol";

/// @title DeployUpkeep
/// @notice Deploys the Chainlink Automation executor for an existing deployment and records it (ADR 039).
/// @dev Separate from `Deploy` on purpose. The upkeep is an optional third executor beside the operator keeper
///      (SPEC §10.3): a deployment works without it, it is added to a Draw that is already live and already handed
///      over to the Safe, and it needs no owner action of any kind -- it has no role to be granted. Running this
///      script therefore changes nothing about custody, ownership or money, and it is the only deployment script
///      that is safe to run after the handover.
///
///      What it does not do, because a contract cannot: **registering** the upkeep with Chainlink Automation and
///      funding it with LINK are operator steps in the Automation app (`contracts/README.md`,
///      `docs/runbooks/testnet-launch.md`). This script writes `contracts.upkeep.registry` and
///      `contracts.upkeep.upkeepId` as the zero address and null; the operator fills them in from the registration
///      receipt. The registry address for a chain is looked up by the operator against Chainlink's own
///      documentation and never guessed here.
///
///        LUCKYDRAW_MANIFEST=../config/deployments/97/<draw>.json \
///          forge script script/DeployUpkeep.s.sol:DeployUpkeep --rpc-url "$LUCKYDRAW_RPC_URL" --broadcast
contract DeployUpkeep is DeploymentScript {
    /// @notice Deploys the upkeep for the manifest named by `LUCKYDRAW_MANIFEST`.
    /// @return path The manifest path, rewritten with the new `contracts.upkeep` record.
    function run() external returns (string memory path) {
        return deployUpkeepAt(vm.envString("LUCKYDRAW_MANIFEST"), msg.sender);
    }

    /// @notice Deploys the upkeep for one manifest on behalf of one broadcaster.
    /// @dev Separated from `run` so the in-process script tests drive the same code with their own fixtures.
    /// @param manifestPath The manifest of the deployment to attach an executor to.
    /// @param broadcaster The deploying address. It gains no authority: the upkeep has no owner.
    /// @return path The manifest path.
    function deployUpkeepAt(string memory manifestPath, address broadcaster) public returns (string memory path) {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);

        require(broadcaster != address(0), "DeployUpkeep: no broadcaster; pass --sender");
        require(
            block.chainid == m.chain.chainId,
            string.concat(
                "DeployUpkeep: chain id mismatch: connected to ",
                vm.toString(block.chainid),
                " but the manifest describes ",
                vm.toString(m.chain.chainId)
            )
        );
        _requireEnvironmentMatchesChain(m);
        require(
            DeploymentLib.eq(m.environment, "local") || !DeploymentLib.referencesMocks(m),
            "DeployUpkeep: a non-local manifest may reference no mock artifact (SPEC 12)"
        );
        require(m.draw.addr != address(0) && m.draw.addr.code.length > 0, "DeployUpkeep: the manifest Draw has no code");
        require(
            m.draw.addr.codehash == m.draw.codeHash,
            "DeployUpkeep: the Draw's runtime code differs from the manifest; run Verify before attaching an executor"
        );
        require(
            m.upkeep.addr == address(0),
            string.concat("DeployUpkeep: this manifest already records an upkeep at ", vm.toString(m.upkeep.addr))
        );

        vm.startBroadcast(broadcaster);
        LuckyDrawUpkeep upkeep = new LuckyDrawUpkeep(m.draw.addr);
        vm.stopBroadcast();

        require(address(upkeep.DRAW()) == m.draw.addr, "DeployUpkeep: the executor is bound to another Draw");

        m.upkeep = DeploymentLib.UpkeepRecord({
            addr: address(upkeep),
            codeHash: address(upkeep).codehash,
            // A script cannot see its own creation block or transaction hash; `Finalize` is not extended for this
            // because the upkeep is deployed on its own, long after the Vault and Draw whose broadcast file it
            // would have to read. The operator records the receipt's block and hash, and `Verify` checks both.
            deployBlock: block.number,
            deployTx: bytes32(0),
            draw: m.draw.addr,
            registry: address(0),
            upkeepId: ""
        });

        path = DeploymentLib.manifestPath(_deploymentsDir(), m.chain.chainId, m.draw.addr);
        DeploymentLib.writeDocument(m, path, false);

        console2.log("DeployUpkeep: upkeep  ", address(upkeep));
        console2.log("DeployUpkeep: draw    ", m.draw.addr);
        console2.log("DeployUpkeep: manifest", path);
        console2.log(
            "DeployUpkeep: next    ",
            "register a custom-logic upkeep at automation.chain.link, fund it with LINK, then record"
        );
        console2.log("DeployUpkeep:         ", "contracts.upkeep.registry, upkeepId, deployBlock and deployTx");
    }

    /// @dev The validator's rule E1, repeated here for the same reason `Deploy` repeats it: a manifest cannot be
    ///      extended on a chain it was not written for.
    function _requireEnvironmentMatchesChain(DeploymentLib.Manifest memory m) private view {
        uint256 expected =
            DeploymentLib.eq(m.environment, "local") ? 31337 : DeploymentLib.eq(m.environment, "testnet") ? 97 : 56;
        require(
            block.chainid == expected,
            string.concat(
                "DeployUpkeep: environment '",
                m.environment,
                "' requires chain id ",
                vm.toString(expected),
                " but this is chain ",
                vm.toString(block.chainid),
                " (config/README.md E1)"
            )
        );
    }
}
