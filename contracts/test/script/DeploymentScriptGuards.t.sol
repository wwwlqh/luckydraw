// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Configure} from "../../script/Configure.s.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeployLocal} from "../../script/DeployLocal.s.sol";
import {DeploymentLib} from "../../script/DeploymentLib.sol";
import {Verify} from "../../script/Verify.s.sol";
import {VerifyHarness} from "./HistoryRpcFixture.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyVault} from "../../src/LuckyVault.sol";

/// @notice Exposes `DeployLocal`'s mock fixture and plan builder so a test can compose the steps itself.
/// @dev Test harness only: it adds no behaviour, it just makes two internal steps callable separately, which is what
///      lets these tests reach the states an operator can actually be in between `Deploy` and `Configure`.
contract DeployLocalHarness is DeployLocal {
    function deployMocksFor(address broadcaster) external {
        _deployMocks(broadcaster);
    }

    function buildPlan() external view returns (DeploymentLib.Manifest memory plan) {
        return _buildPlan();
    }

    function mockArtifacts() external pure returns (string[] memory names) {
        return _mockArtifacts();
    }
}

/// @notice An account with code, standing in for an operator Safe.
/// @dev SPEC §10.5 fixes what a real Safe must be; the deployment scripts only require that the three privileged
///      roles are contracts on the chain being deployed to, which is what an address pasted from another chain is
///      not. Nothing is called on it.
contract SafeStub {}

/// @notice The pre-conditions the deployment scripts refuse to proceed without (SPEC §6.2, §7.3, §15).
/// @dev Each test drives `Deploy` or `Configure` into the exact state an operator can be in -- wrong chain, a
///      coordinator that is not a VRF coordinator, an unregistered consumer, an underfunded subscription -- and
///      asserts the script stops before it can do damage.
contract DeploymentScriptGuardsTest is Test {
    uint256 internal constant START = 1_789_128_000;
    string internal constant BASE_DIR = "./test/script/tmp/guards";

    DeployLocalHarness internal harness;
    Deploy internal deployer;
    Configure internal configure;
    VerifyHarness internal verifier;
    address internal operator;
    string internal planPath;

    function setUp() public {
        vm.warp(START);
        operator = makeAddr("operator");
    }

    /// @dev Deploys the mock fixture into a directory of its own. Foundry runs the test functions of one contract
    ///      in parallel, so every test needs its own document paths.
    function _fixture(string memory tag) internal {
        string memory dir = string.concat(BASE_DIR, "/", tag);
        harness = new DeployLocalHarness();
        harness.setDeploymentsDir(dir);
        deployer = new Deploy();
        deployer.setDeploymentsDir(dir);
        configure = new Configure();
        configure.setDeploymentsDir(dir);
        verifier = new VerifyHarness();
        verifier.setDeploymentsDir(dir);

        harness.deployMocksFor(operator);
        planPath = string.concat(dir, "/31337/guards.plan.json");
    }

    // ---------------------------------------------------------------------
    // Deploy
    // ---------------------------------------------------------------------

    function test_DeployRevertsOnAChainIdMismatch() public {
        _fixture("chain-id");
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        plan.chain.chainId = 56;
        plan.environment = "mainnet";
        DeploymentLib.writeDocument(plan, planPath, true);

        vm.expectRevert(bytes("Deploy: chain id mismatch: connected to 31337 but the plan targets 56"));
        deployer.deployPlanAt(planPath, operator);
    }

    function test_DeployRevertsWhenTheCoordinatorDoesNotExposeProvingKeys() public {
        _fixture("no-proving-keys");
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        // The mock ERC-20 has code but is not a VRF coordinator: the §6.2 pre-check would revert forever.
        plan.vrf.coordinator = address(harness.token());
        DeploymentLib.writeDocument(plan, planPath, true);

        vm.expectRevert(
            bytes("Deploy: coordinator does not expose s_provingKeys(bytes32) returns (bool,uint64) (SPEC 15 VRF)")
        );
        deployer.deployPlanAt(planPath, operator);
    }

    function test_DeployRevertsWhenTheCoordinatorHasNoCode() public {
        _fixture("no-coordinator-code");
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        plan.vrf.coordinator = address(0xC0FFEE);
        DeploymentLib.writeDocument(plan, planPath, true);

        vm.expectRevert(
            bytes(string.concat("Deploy: no contract at the VRF coordinator address ", vm.toString(address(0xC0FFEE))))
        );
        deployer.deployPlanAt(planPath, operator);
    }

    function test_DeployRevertsWhenAPlanUnderstatesItsOwnRequestCost() public {
        _fixture("request-cost");
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        plan.vrf.maxRequestCostNative = 1;
        plan.vrf.lowFundingThresholdNative = 1;
        DeploymentLib.writeDocument(plan, planPath, true);

        vm.expectRevert(bytes("Deploy: maxRequestCostNative 1 is below its own derivation 3612500000000000"));
        deployer.deployPlanAt(planPath, operator);
    }

    function test_DeployRevertsOnANonLocalPlanThatReferencesAMock() public {
        _fixture("mock-policy");
        DeploymentLib.Manifest memory plan = _safeRoles(harness.buildPlan());
        plan.environment = "testnet";
        plan.chain.chainId = 31337; // keep the chain check happy so the mock rule is the one that fires
        DeploymentLib.writeDocument(plan, planPath, true);

        vm.expectRevert(bytes("Deploy: a non-local plan may reference no mock artifact (SPEC 12)"));
        deployer.deployPlanAt(planPath, operator);
    }

    /// @dev The mock labels are the document's own word for itself, so clearing them must change nothing: the
    ///      coordinator, the feeds and the token are still this repository's mocks and their deployed code says so.
    function test_DeployRevertsOnATestnetPlanBuiltOnUnlabeledMocks() public {
        _fixture("unlabeled-mocks");
        DeploymentLib.Manifest memory plan = _unlabeled(_safeRoles(harness.buildPlan()));
        plan.environment = "testnet";
        plan.chain.chainId = 31337;
        DeploymentLib.writeDocument(plan, planPath, true);
        assertFalse(plan.vrf.coordinatorIsMock, "every mock label is cleared");
        assertFalse(plan.assets[1].isMock, "every mock label is cleared");

        vm.expectRevert(bytes("Deploy: a non-local plan may reference no mock artifact (SPEC 12)"));
        deployer.deployPlanAt(planPath, operator);
    }

    /// @dev The code comparison itself: the two mocks without immutable variables are matched on their exact runtime
    ///      code hash, and `MockERC20` -- whose `decimals` is immutable and therefore spliced into its runtime code
    ///      at construction -- is matched whatever it was deployed with. A contract that is not a mock is not one.
    function test_MockDetectionIdentifiesTheRepositoryMocksByCode() public {
        _fixture("mock-detection");
        assertTrue(DeploymentLib.isRepositoryMock(address(harness.coordinator())), "the coordinator mock");
        assertTrue(DeploymentLib.isRepositoryMock(address(harness.nativeFeed())), "the aggregator mock");
        assertTrue(DeploymentLib.isRepositoryMock(address(harness.token())), "the 2-decimal token mock");
        assertTrue(
            DeploymentLib.isRepositoryMock(address(new MockERC20("Eighteen", "E18", 18))),
            "the same mock with another immutable decimals value"
        );
        assertFalse(DeploymentLib.isRepositoryMock(address(new SafeStub())), "an ordinary contract is not a mock");
        assertFalse(DeploymentLib.isRepositoryMock(address(new LuckyVault(operator))), "the Vault is not a mock");
        assertFalse(DeploymentLib.isRepositoryMock(makeAddr("eoa")), "an account without code is not a mock");
        assertFalse(DeploymentLib.isRepositoryMock(address(0)), "the zero address is not a mock");
    }

    /// @dev Validator rule E1 (config/README.md): `local` exists only on 31337, testnet is 97 and mainnet is 56.
    function test_DeployRevertsOnALocalPlanOffChain31337() public {
        _fixture("local-off-chain");
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        plan.chain.chainId = 56;
        DeploymentLib.writeDocument(plan, planPath, true);
        vm.chainId(56);

        vm.expectRevert(
            bytes("Deploy: environment 'local' requires chain id 31337 but this is chain 56 (config/README.md E1)")
        );
        deployer.deployPlanAt(planPath, operator);
    }

    /// @dev SPEC §10.5 and §12.1: off `local` the owner, treasury and seed roles are Safes. `feeAccount` is the
    ///      sharpest case because every round freezes it at creation and no setter can move it afterwards.
    function test_DeployRevertsWhenTheFeeAccountIsNotAContractOffLocal() public {
        _fixture("eoa-fee-account");
        DeploymentLib.Manifest memory plan = _safeRoles(harness.buildPlan());
        plan.environment = "testnet";
        plan.chain.chainId = 31337;
        plan.ownership.feeAccount = makeAddr("treasury-eoa");
        DeploymentLib.writeDocument(plan, planPath, true);

        vm.expectRevert(
            bytes(
                "Deploy: ownership.feeAccount has no code; the treasury role is a Safe outside local (SPEC 10.5, 12.1)"
            )
        );
        deployer.deployPlanAt(planPath, operator);
    }

    // ---------------------------------------------------------------------
    // Configure: the VRF pre-conditions of addPool
    // ---------------------------------------------------------------------

    function test_ConfigureRefusesToAddAPoolBeforeTheConsumerIsRegistered() public {
        _fixture("no-consumer");
        string memory manifestPath = _deployPair();

        vm.expectRevert(
            bytes(
                "Configure: the Draw is not a registered consumer of subscription 1; register it before addPool (SPEC 7.3)"
            )
        );
        configure.configureAt(manifestPath, operator);

        // Nothing was half-applied: the Vault listing happens in the same transaction and is rolled back with it.
        assertEq(LuckyDraw(_draw(manifestPath)).poolCount(), 0, "no pool was created");
        assertFalse(LuckyVault(_vault(manifestPath)).getAsset(address(0)).listed, "nothing was listed");
    }

    function test_ConfigureRefusesToAddAPoolWhileTheSubscriptionIsBelowTheThreshold() public {
        _fixture("underfunded");
        string memory manifestPath = _deployPair();
        harness.coordinator().addConsumer(harness.subscriptionId(), _draw(manifestPath));
        harness.coordinator().fundNative(harness.subscriptionId(), 1 gwei);

        vm.expectRevert(
            bytes(
                "Configure: subscription native balance 1000000000 is below the low-funding threshold 36125000000000000 (SPEC 6.2, 15)"
            )
        );
        configure.configureAt(manifestPath, operator);
        assertEq(LuckyDraw(_draw(manifestPath)).poolCount(), 0, "no pool was created");
    }

    function test_ConfigureProceedsOnceTheSubscriptionIsRegisteredAndFunded() public {
        _fixture("configured");
        string memory manifestPath = _deployPair();
        harness.coordinator().addConsumer(harness.subscriptionId(), _draw(manifestPath));

        configure.configureAt(manifestPath, operator);

        LuckyDraw draw = LuckyDraw(_draw(manifestPath));
        assertEq(draw.poolCount(), 2, "both pools created");
        assertEq(draw.roundCount(), 14, "seven rounds per pool");
        // A plan may not name mock artifacts, so a manifest built by `Deploy` alone has an empty `mocks` list and
        // fails exactly the one local-environment check that `DeployLocal` satisfies by filling it in.
        assertEq(verifier.verifyManifestAt(manifestPath), 1, "only the mock-artifact list is missing");
        vm.writeJson("[\"MockERC20\",\"MockAggregatorV3\",\"MockVRFCoordinatorV2Plus\"]", manifestPath, ".mocks");
        // The seed account has not consented yet, so the manifest records a null cap; everything else verifies.
        assertEq(verifier.verifyManifestAt(manifestPath), 0, "Verify passes");

        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        assertEq(m.assets[0].pool.seedAuthorizedMaxPerRound, "", "no seed consent recorded");
    }

    /// @dev The subscription id is constructor-fixed on the Draw (SPEC §7.1) but only recorded in the manifest, and
    ///      `_requireVrfReady` asks the manifest which subscription to look at. An edited id therefore points the
    ///      readiness check at a healthy subscription while the Draw would request from another one: without this
    ///      check the run opens six rounds that can never draw.
    function test_ConfigureRefusesAManifestWhoseSubscriptionIdWasEdited() public {
        _fixture("vrf-subscription");
        string memory manifestPath = _deployPair();
        harness.coordinator().addConsumer(harness.subscriptionId(), _draw(manifestPath));

        // A second, perfectly healthy subscription the Draw is registered on and which is funded well above the
        // threshold: everything `_requireVrfReady` looks at passes, and the Draw still cannot use it.
        uint256 other = harness.coordinator().createSubscription();
        harness.coordinator().addConsumer(other, _draw(manifestPath));
        harness.coordinator().fundNative(other, 1 ether);
        assertEq(other, 2, "the second subscription is id 2");
        vm.writeJson("\"2\"", manifestPath, ".vrf.subscriptionId");

        vm.expectRevert(bytes("Configure: vrf.subscriptionId differs from the Draw"));
        configure.configureAt(manifestPath, operator);
        assertEq(LuckyDraw(_draw(manifestPath)).poolCount(), 0, "no pool was created");
    }

    function test_ConfigureRefusesAManifestWhoseCodeHashMoved() public {
        _fixture("code-hash");
        string memory manifestPath = _deployPair();
        vm.writeJson(
            "\"0x2222222222222222222222222222222222222222222222222222222222222222\"",
            manifestPath,
            ".contracts.draw.codeHash"
        );

        vm.expectRevert(bytes("Configure: Draw code hash differs from the manifest"));
        configure.configureAt(manifestPath, operator);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev Writes the local plan and runs `Deploy` alone, leaving the pair deployed but unconfigured.
    function _deployPair() private returns (string memory manifestPath) {
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        DeploymentLib.writeDocument(plan, planPath, true);
        manifestPath = deployer.deployPlanAt(planPath, operator);
        verifier.seedManifest(manifestPath);
        return manifestPath;
    }

    /// @dev Gives the three privileged roles accounts with code, so a non-local plan reaches the checks that come
    ///      after the SPEC §10.5 role rule.
    function _safeRoles(DeploymentLib.Manifest memory plan) private returns (DeploymentLib.Manifest memory) {
        plan.ownership.finalOwner = address(new SafeStub());
        plan.ownership.feeAccount = address(new SafeStub());
        plan.ownership.seedAccount = address(new SafeStub());
        return plan;
    }

    /// @dev Clears every mock label the document carries about itself, leaving the mock addresses in place.
    function _unlabeled(DeploymentLib.Manifest memory plan) private pure returns (DeploymentLib.Manifest memory) {
        plan.vrf.coordinatorIsMock = false;
        for (uint256 i = 0; i < plan.assets.length; ++i) {
            plan.assets[i].isMock = false;
            plan.assets[i].price.feedIsMock = false;
        }
        plan.mocks = new string[](0);
        return plan;
    }

    function _draw(string memory manifestPath) private view returns (address) {
        return DeploymentLib.readDocument(manifestPath).draw.addr;
    }

    function _vault(string memory manifestPath) private view returns (address) {
        return DeploymentLib.readDocument(manifestPath).vault.addr;
    }
}
