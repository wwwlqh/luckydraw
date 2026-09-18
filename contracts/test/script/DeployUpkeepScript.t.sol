// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyDrawUpkeep} from "../../src/LuckyDrawUpkeep.sol";
import {DeployLocal} from "../../script/DeployLocal.s.sol";
import {DeployUpkeep} from "../../script/DeployUpkeep.s.sol";
import {DeploymentLib} from "../../script/DeploymentLib.sol";
import {VerifyHarness} from "./HistoryRpcFixture.sol";

/// @notice In-process tests of `DeployUpkeep` (ADR 039).
/// @dev Its own directory under `test/script/tmp`, because Foundry runs test contracts in parallel inside one
///      process and two suites writing the same manifest path would race.
contract DeployUpkeepScriptTest is Test {
    uint256 internal constant START = 1_789_128_000;
    string internal constant BASE_DIR = "./test/script/tmp/upkeep";

    address internal operator;
    DeployLocal internal local;
    LuckyDraw internal draw;

    function setUp() public {
        vm.warp(START);
        operator = makeAddr("operator");
    }

    function _deployLocal(string memory tag) internal returns (string memory manifestPath, DeployUpkeep script) {
        string memory dir = string.concat(BASE_DIR, "/", tag);
        local = new DeployLocal();
        local.setDeploymentsDir(dir);
        manifestPath = local.runAs(operator);
        draw = local.draw();
        script = new DeployUpkeep();
        script.setDeploymentsDir(dir);
    }

    function test_RecordsTheExecutorInTheManifest() public {
        (string memory path, DeployUpkeep script) = _deployLocal("records");
        DeploymentLib.Manifest memory before = DeploymentLib.readDocument(path);
        assertEq(before.upkeep.addr, address(0), "no upkeep before the run");

        script.deployUpkeepAt(path, operator);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);

        assertTrue(m.upkeep.addr != address(0), "upkeep recorded");
        assertEq(m.upkeep.draw, address(draw), "bound to the manifest Draw");
        assertEq(m.upkeep.codeHash, m.upkeep.addr.codehash, "code hash matches the deployed runtime code");
        assertEq(m.upkeep.registry, address(0), "registration is an operator step, not a script step");
        assertEq(m.upkeep.upkeepId, "", "no upkeep id until the operator registers it");
        assertEq(address(LuckyDrawUpkeep(m.upkeep.addr).DRAW()), address(draw), "LuckyDrawUpkeep.DRAW()");

        // Everything the manifest already recorded survives the rewrite.
        assertEq(m.draw.addr, before.draw.addr, "draw address");
        assertEq(m.vault.addr, before.vault.addr, "vault address");
        assertEq(m.assets.length, before.assets.length, "assets");
        assertEq(m.mocks.length, before.mocks.length, "mocks");
        assertEq(m.deploymentId, before.deploymentId, "deploymentId");
    }

    function test_TheDeployedExecutorHoldsNoRole() public {
        (string memory path, DeployUpkeep script) = _deployLocal("no-role");
        script.deployUpkeepAt(path, operator);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        address up = m.upkeep.addr;

        assertTrue(up != draw.owner() && up != draw.pendingOwner(), "not the owner");
        assertTrue(up != draw.feeAccount(), "not the treasury");
        assertTrue(up != draw.getSeedAccount(), "not the seed account");
        assertTrue(up != m.ownership.finalOwner, "not the final owner");
        assertEq(up.balance, 0, "holds nothing");
    }

    function test_VerifyAcceptsAManifestThatRecordsTheExecutor() public {
        string memory dir = string.concat(BASE_DIR, "/verify-ok");
        local = new DeployLocal();
        local.setDeploymentsDir(dir);
        string memory path = local.runAs(operator);
        draw = local.draw();

        DeployUpkeep script = new DeployUpkeep();
        script.setDeploymentsDir(dir);
        script.deployUpkeepAt(path, operator);

        VerifyHarness verifier = new VerifyHarness();
        verifier.setDeploymentsDir(dir);
        verifier.seedManifest(path);
        assertEq(verifier.verifyManifestAt(path), 0, "Verify accepts a deployment with an executor");
    }

    function test_VerifyRejectsATamperedUpkeepCodeHash() public {
        string memory dir = string.concat(BASE_DIR, "/verify-tampered");
        local = new DeployLocal();
        local.setDeploymentsDir(dir);
        string memory path = local.runAs(operator);

        DeployUpkeep script = new DeployUpkeep();
        script.setDeploymentsDir(dir);
        script.deployUpkeepAt(path, operator);

        VerifyHarness verifier = new VerifyHarness();
        verifier.setDeploymentsDir(dir);
        verifier.seedManifest(path);

        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        m.upkeep.codeHash = keccak256("not the executor this repository builds");
        DeploymentLib.writeDocument(m, path, false);
        assertGt(verifier.verifyManifestAt(path), 0, "Verify refuses an executor whose code moved");
    }

    function test_RevertWhen_AnUpkeepIsAlreadyRecorded() public {
        (string memory path, DeployUpkeep script) = _deployLocal("twice");
        script.deployUpkeepAt(path, operator);

        vm.expectRevert();
        script.deployUpkeepAt(path, operator);
    }

    function test_RevertWhen_TheConnectedChainIsNotTheManifests() public {
        (string memory path, DeployUpkeep script) = _deployLocal("wrong-chain");
        vm.chainId(56);
        vm.expectRevert();
        script.deployUpkeepAt(path, operator);
    }

    /// @dev The mainnet shape is `environment: "mainnet"` on chain 56. A local manifest relabelled `mainnet` is
    ///      refused on chain 31337 by rule E1, and on chain 56 by the mock rule, so relabelling alone never
    ///      reaches a broadcast.
    function test_RevertWhen_AMainnetLabelDoesNotMatchTheChain() public {
        (string memory path, DeployUpkeep script) = _deployLocal("mainnet-label");
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        m.environment = "mainnet";
        DeploymentLib.writeDocument(m, path, false);

        vm.expectRevert();
        script.deployUpkeepAt(path, operator);
    }

    function test_RevertWhen_AMainnetShapedManifestStillReferencesMocks() public {
        (string memory path, DeployUpkeep script) = _deployLocal("mainnet-mocks");
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        m.environment = "mainnet";
        m.chain.chainId = 56;
        DeploymentLib.writeDocument(m, path, false);

        vm.chainId(56);
        vm.expectRevert();
        script.deployUpkeepAt(path, operator);
    }

    function test_RevertWhen_TheDrawCodeHashMoved() public {
        (string memory path, DeployUpkeep script) = _deployLocal("code-hash");
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        m.draw.codeHash = keccak256("not the deployed code");
        DeploymentLib.writeDocument(m, path, false);

        vm.expectRevert();
        script.deployUpkeepAt(path, operator);
    }
}
