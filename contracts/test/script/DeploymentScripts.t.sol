// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Configure} from "../../script/Configure.s.sol";
import {DeployLocal} from "../../script/DeployLocal.s.sol";
import {DeploymentLib} from "../../script/DeploymentLib.sol";
import {Verify} from "../../script/Verify.s.sol";
import {VerifyHarness, FinalizeHarness} from "./HistoryRpcFixture.sol";
import {ILuckyDraw} from "../../src/interfaces/ILuckyDraw.sol";
import {ILuckyVault} from "../../src/interfaces/ILuckyVault.sol";
import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyVault} from "../../src/LuckyVault.sol";
import {Kind, KIND_COUNT, NATIVE_ASSET, PricingConfig, ReferenceKind} from "../../src/Types.sol";
import {MockAggregatorV3} from "../mocks/MockAggregatorV3.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @notice The deployment scripts run in process against their own mocks (SPEC §12, §14 "Local baseline").
/// @dev These are tests of the scripts, not of the contracts: they assert that the manifest `DeployLocal` writes is
///      the chain's own state, that `Verify` fails on every falsified field, and that `Configure` can be re-run.
///
///      Each test deploys into its own directory under `test/script/tmp/main/<tag>`, which `foundry.toml` grants
///      read-write. The tag is explicit rather than shared because Foundry runs the test functions of one contract
///      in parallel: two tests sharing a document path would read each other's half-written files.
contract DeploymentScriptsTest is Test {
    /// @dev 2026-09-11 12:00:00 UTC, the same instant the contract suites use.
    uint256 internal constant START = 1_789_128_000;

    string internal constant BASE_DIR = "./test/script/tmp/main";

    DeployLocal internal local;
    VerifyHarness internal verifier;
    address internal operator;
    LuckyVault internal vault;
    LuckyDraw internal draw;

    function setUp() public {
        vm.warp(START);
        operator = makeAddr("operator");
    }

    /// @dev Runs the whole local deployment into a directory of its own and returns the manifest path.
    function _deployLocal(string memory tag) internal returns (string memory manifestPath) {
        string memory dir = string.concat(BASE_DIR, "/", tag);
        local = new DeployLocal();
        local.setDeploymentsDir(dir);
        verifier = new VerifyHarness();
        verifier.setDeploymentsDir(dir);

        manifestPath = local.runAs(operator);
        vault = local.vault();
        draw = local.draw();
        verifier.seedManifest(manifestPath);
    }

    // ---------------------------------------------------------------------
    // The manifest is the chain's own state
    // ---------------------------------------------------------------------

    function test_ManifestRecordsTheDeployedPair() public {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(_deployLocal("pair"));

        assertEq(m.schemaVersion, DeploymentLib.SCHEMA_VERSION, "schemaVersion");
        assertEq(m.environment, "local", "environment");
        assertEq(m.createdAtUtc, "2026-09-11T12:00:00Z", "createdAtUtc");
        assertEq(
            m.deploymentId,
            string.concat("31337:", DeploymentLib.lowerHex(address(draw))),
            "deploymentId is chainId:lowercase draw"
        );
        assertEq(m.chain.chainId, 31337, "chainId");
        assertEq(m.chain.name, "anvil-local", "chain name");
        assertEq(m.chain.confirmationDepth, 200, "confirmation depth");
        assertTrue(m.chain.startBlock > 0 && m.chain.startBlock <= m.vault.deployBlock, "startBlock");

        assertEq(m.vault.addr, address(vault), "vault address");
        assertEq(m.draw.addr, address(draw), "draw address");
        assertEq(m.vault.codeHash, address(vault).codehash, "vault code hash");
        assertEq(m.draw.codeHash, address(draw).codehash, "draw code hash");
        assertEq(m.vault.deployTx, keccak256(abi.encode(address(vault))), "synthetic receipt identity");

        assertEq(m.toolchain.solc, "0.8.28", "solc pin");
        assertEq(m.toolchain.evmVersion, "paris", "evm pin");
        assertEq(m.toolchain.optimizerRuns, 600, "optimizer runs pin");
        assertTrue(m.toolchain.viaIr, "via_ir pin");

        assertEq(m.drawConstructor.vault, address(vault), "constructorArgs.vault");
        assertEq(m.drawConstructor.initialOwner, operator, "constructorArgs.initialOwner");
        assertEq(m.drawConstructor.subscriptionId, draw.SUBSCRIPTION_ID(), "constructorArgs.subscriptionId");
        assertEq(m.drawConstructor.keyHash, draw.KEY_HASH(), "constructorArgs.keyHash");
        assertEq(m.drawConstructor.callbackGasLimit, draw.CALLBACK_GAS_LIMIT(), "constructorArgs.callbackGasLimit");

        assertEq(m.vrf.coordinator, address(draw.VRF_COORDINATOR()), "vrf coordinator");
        assertTrue(m.vrf.coordinatorIsMock, "coordinator is a mock");
        assertTrue(m.vrf.consumerRegistered, "consumer registered");
        assertEq(m.vrf.subscriptionOwner, operator, "subscription owner");
        assertEq(m.vrf.numWords, 2, "numWords");
        assertEq(m.vrf.requestConfirmations, 200, "confirmations");
        assertEq(m.vrf.maxRequestCostNative, draw.MAX_REQUEST_COST_NATIVE(), "max request cost");
        // 5 gwei x (300,000 + 115,000) x 1.5 + 0.0005 BNB (SPEC §7.1 derivation).
        assertEq(m.vrf.maxRequestCostNative, 3_612_500_000_000_000, "derivation value");
        assertEq(DeploymentLib.derivedMaxRequestCost(m.vrf), m.vrf.maxRequestCostNative, "derivation reproduces");
        assertEq(m.vrf.lowFundingThresholdNative, 36_125_000_000_000_000, "low funding threshold");

        assertEq(m.mocks.length, 3, "mock artifacts named");
        assertTrue(DeploymentLib.referencesMocks(m), "local manifest references mocks");
    }

    function test_ManifestRecordsTheOwnershipHandover() public {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(_deployLocal("ownership-record"));

        assertEq(m.vault.owner, operator, "vault owner is the deployer");
        assertEq(m.draw.owner, operator, "draw owner is the deployer");
        assertEq(m.vault.pendingOwner, m.ownership.finalOwner, "vault pending owner");
        assertEq(m.draw.pendingOwner, m.ownership.finalOwner, "draw pending owner");
        assertFalse(m.ownership.ownershipAccepted, "ownership not accepted yet");

        assertEq(vault.owner(), operator, "live vault owner");
        assertEq(vault.pendingOwner(), m.ownership.finalOwner, "live vault pending owner");
        assertEq(draw.pendingOwner(), m.ownership.finalOwner, "live draw pending owner");
        assertEq(draw.feeAccount(), m.ownership.feeAccount, "fee account");
        assertEq(draw.getSeedAccount(), m.ownership.seedAccount, "seed account");
    }

    function test_ManifestRecordsEveryPoolAndListing() public {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(_deployLocal("pools"));
        assertEq(m.assets.length, 2, "two assets");
        assertEq(draw.poolCount(), 2, "two pools");

        for (uint256 i = 0; i < m.assets.length; ++i) {
            DeploymentLib.AssetSpec memory a = m.assets[i];
            ILuckyVault.AssetRecord memory record = vault.getAsset(a.asset);
            assertTrue(a.listed && record.listed, "listed");
            assertEq(record.tokenDecimals, a.decimals, "decimals");
            assertTrue(record.depositsEnabled && a.depositsEnabled, "deposits enabled");
            assertTrue(a.isMock, "local assets are labeled mocks");
            assertEq(a.status, "mock-local", "mock status");

            ILuckyDraw.PoolView memory pool = draw.getPool(a.pool.poolId);
            assertEq(pool.asset, a.asset, "pool asset");
            assertEq(pool.seedAmount, a.pool.seedAmount, "seed amount");
            assertTrue(pool.enabled && a.pool.enabled, "pool enabled");
            assertEq(pool.nextPricing.feed, a.price.feed, "pricing feed");
            assertEq(pool.nextPricing.maxPriceAge, a.price.maxPriceAge, "pricing max age");
            assertEq(uint256(pool.nextPricing.feedDecimals), a.price.feedDecimals, "pricing decimals");
            for (uint256 k = 0; k < KIND_COUNT; ++k) {
                assertEq(uint256(pool.targetUsd[k]), a.pool.targetsUsd[k], "target");
                uint256 roundId = a.pool.firstRoundIds[k];
                assertEq(roundId, draw.getCurrent(a.pool.poolId, Kind(k)), "first round is the current round");
                ILuckyDraw.RoundView memory round = draw.getRound(roundId);
                assertEq(round.poolId, a.pool.poolId, "round pool");
                assertEq(uint256(round.sequence), 1, "first round of the sequence");
                assertEq(round.pricing.feed, a.price.feed, "round froze the pricing config");
            }
            assertEq(
                a.pool.seedAuthorizedMaxPerRound,
                vm.toString(vault.seedMaxPerRound(m.ownership.seedAccount, a.asset)),
                "recorded seed cap"
            );
        }

        assertEq(m.assets[0].asset, NATIVE_ASSET, "first pool is native BNB");
        assertEq(m.assets[0].pool.seedAmount, 0.01 ether, "native seed is 0.01 BNB");
        assertEq(m.assets[1].pool.seedAmount, 500, "token seed is 5.00 TEST2");
        assertEq(m.assets[1].decimals, 2, "TEST2 has two decimals");
    }

    function test_ManifestAndPlanAreLfTerminatedWithoutCarriageReturns() public {
        string memory manifestPath = _deployLocal("line-endings");
        _assertLfTerminated(manifestPath);
        _assertLfTerminated(local.planPath());
    }

    function test_PlanRoundTripsThroughTheDocumentReader() public {
        _deployLocal("plan");
        DeploymentLib.Manifest memory plan = DeploymentLib.readDocument(local.planPath());

        assertEq(plan.name, "local", "plan name matches the file name");
        assertEq(plan.environment, "local", "plan environment");
        assertEq(plan.chain.chainId, 31337, "plan chain");
        assertEq(plan.vrf.coordinator, address(draw.VRF_COORDINATOR()), "plan coordinator");
        assertEq(plan.assets.length, 2, "plan assets");
        assertEq(plan.assets[1].symbol, "TEST2", "plan asset symbol");
        // A plan carries no deployed fact (deployment-plan.schema.json forbids them).
        assertEq(plan.deploymentId, "", "plan has no deploymentId");
        assertEq(plan.createdAtUtc, "", "plan has no createdAtUtc");
        assertEq(plan.vault.addr, address(0), "plan has no contracts");
        assertEq(plan.chain.startBlock, 0, "plan has no start block");
        assertEq(plan.mocks.length, 0, "plan names no mock artifacts");
        assertFalse(plan.assets[0].listed, "plan has no listing flag");
        assertEq(plan.assets[0].pool.poolId, 0, "plan has no pool id");
    }

    // ---------------------------------------------------------------------
    // Verify
    // ---------------------------------------------------------------------

    function test_VerifyPassesOnTheLocalManifest() public {
        string memory path = _deployLocal("verify-ok");
        assertEq(verifier.verifyManifestAt(path), 0, "no failed checks");
    }

    function test_VerifyFailsOnATamperedCodeHash() public {
        string memory path = _deployLocal("verify-code-hash");
        vm.writeJson(
            "\"0x1111111111111111111111111111111111111111111111111111111111111111\"", path, ".contracts.vault.codeHash"
        );
        assertEq(verifier.verifyManifestAt(path), 1, "exactly the code hash check fails");
    }

    function test_VerifyFailsOnAWrongBinding() public {
        string memory path = _deployLocal("verify-binding");
        // A second Vault with identical runtime code: the code hash still matches, but nothing is bound to it.
        LuckyVault other = new LuckyVault(operator);
        vm.writeJson(
            string.concat("\"", DeploymentLib.lowerHex(address(other)), "\""), path, ".contracts.vault.address"
        );
        vm.expectRevert("History: contract address mismatch");
        verifier.verifyManifestAt(path);
    }

    function test_VerifyFailsOnAWrongTarget() public {
        string memory path = _deployLocal("verify-target");
        // `vm.writeJson` cannot address an array element, so the document is edited as text; both pools carry the
        // same Day100 target, so both pool-target checks fail and nothing else does.
        _replaceInFile(path, "\"Day100\": 100", "\"Day100\": 250");
        assertEq(verifier.verifyManifestAt(path), 2, "exactly the two Day100 target checks fail");
    }

    function test_VerifyFailsOnAWrongFeeAccount() public {
        string memory path = _deployLocal("verify-fee-account");
        vm.writeJson("\"0x000000000000000000000000000000000000dead\"", path, ".ownership.feeAccount");
        // Draw.feeAccount and the recorded constructor argument both disagree with the manifest.
        assertEq(verifier.verifyManifestAt(path), 2, "the fee account checks fail");
    }

    function test_VerifyFailsOnAWrongSeedAccount() public {
        string memory path = _deployLocal("verify-seed-account");
        vm.writeJson("\"0x000000000000000000000000000000000000dead\"", path, ".ownership.seedAccount");
        assertGt(verifier.verifyManifestAt(path), 0, "the seed account checks fail");
    }

    function test_VerifyRefusesANonLocalManifestThatReferencesAMock() public {
        string memory path = _deployLocal("verify-environment");
        vm.writeJson("\"testnet\"", path, ".environment");
        // The mock policy, plus the three SPEC §10.5/§12.1 role checks: the local run's labeled anvil accounts are
        // externally owned, which is exactly what a testnet manifest may not record.
        assertEq(verifier.verifyManifestAt(path), 4, "the mock policy and the three Safe roles fail");
    }

    /// @dev The same manifest with every mock label scrubbed: `referencesMocks` compares the recorded addresses with
    ///      the deployed code of the mocks themselves, so the document cannot talk its way out of the §12 rule.
    function test_VerifyRefusesANonLocalManifestOnUnlabeledMocks() public {
        string memory path = _deployLocal("verify-unlabeled-mocks");
        vm.writeJson("\"testnet\"", path, ".environment");
        vm.writeJson("[]", path, ".mocks");
        _replaceInFile(path, "\"coordinatorIsMock\": true", "\"coordinatorIsMock\": false");
        _replaceInFile(path, "\"isMock\": true", "\"isMock\": false");
        _replaceInFile(path, "\"feedIsMock\": true", "\"feedIsMock\": false");
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        assertFalse(m.vrf.coordinatorIsMock, "no label is left");
        assertFalse(m.assets[1].isMock || m.assets[1].price.feedIsMock, "no label is left");
        assertTrue(DeploymentLib.referencesMocks(m), "the deployed code still says mock");

        assertEq(verifier.verifyManifestAt(path), 4, "the mock policy and the three Safe roles fail");
    }

    /// @dev Verify walked the manifest's assets, so a pool nobody recorded was invisible to it. The owner can add
    ///      one at any time before the handover completes (SPEC §8.1), and a pool is what the deployment plays.
    function test_VerifySeesAPoolTheManifestDoesNotRecord() public {
        string memory path = _deployLocal("verify-rogue-pool");
        MockERC20 rogue = new MockERC20("Rogue token", "ROGUE", 18);
        MockAggregatorV3 rogueFeed = new MockAggregatorV3(8);
        rogueFeed.set(1, 1e8, block.timestamp);

        vm.startPrank(operator); // the handover is still pending, so the deploying operator can still add a pool
        vault.listAsset(address(rogue), 18);
        draw.addPool(
            address(rogue),
            PricingConfig({
                feed: address(rogueFeed),
                feedDecimals: 8,
                maxPriceAge: 3600,
                referenceKind: ReferenceKind.ExactToken,
                minAnswer: 0,
                maxAnswer: 0
            })
        );
        vm.stopPrank();
        assertEq(draw.poolCount(), 3, "a third pool exists on chain");

        assertEq(verifier.verifyManifestAt(path), 1, "exactly the pool count check fails");
    }

    function test_VerifyFailsOnATamperedPoolPricingFeed() public {
        string memory path = _deployLocal("verify-pricing");
        _replaceInFile(
            path, DeploymentLib.lowerHex(address(local.tokenFeed())), "0x000000000000000000000000000000000000dead"
        );
        // The pool's next pricing config and the frozen config of all seven first rounds of that pool.
        assertEq(verifier.verifyManifestAt(path), 8, "the pricing checks fail");
    }

    // ---------------------------------------------------------------------
    // Ownership and idempotency
    // ---------------------------------------------------------------------

    function test_OwnershipEndsPendingAndTheFinalOwnerCanAccept() public {
        string memory path = _deployLocal("ownership-accept");
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        address finalOwner = m.ownership.finalOwner;
        assertTrue(finalOwner != operator, "the final owner is not the deployer");

        vm.prank(finalOwner);
        vault.acceptOwnership();
        vm.prank(finalOwner);
        draw.acceptOwnership();

        assertEq(vault.owner(), finalOwner, "vault owner after acceptance");
        assertEq(draw.owner(), finalOwner, "draw owner after acceptance");
        assertEq(vault.pendingOwner(), address(0), "no vault transfer pending");
        assertEq(draw.pendingOwner(), address(0), "no draw transfer pending");

        // The manifest now describes the previous state, which Verify must notice.
        assertGt(verifier.verifyManifestAt(path), 0, "Verify sees the accepted ownership");

        // Re-running Configure records it; nothing else changes because the desired state already holds.
        Configure configure = new Configure();
        configure.setDeploymentsDir(string.concat(BASE_DIR, "/ownership-accept"));
        configure.configureAt(path, finalOwner);
        assertEq(verifier.verifyManifestAt(path), 0, "Verify passes on the refreshed manifest");

        DeploymentLib.Manifest memory updated = DeploymentLib.readDocument(path);
        assertTrue(updated.ownership.ownershipAccepted, "ownershipAccepted recorded");
        assertEq(updated.vault.pendingOwner, address(0), "pending owner cleared");
    }

    function test_ConfigureIsIdempotent() public {
        string memory path = _deployLocal("idempotent");
        string memory before = vm.readFile(path);
        uint256 poolCountBefore = draw.poolCount();
        uint256 roundCountBefore = draw.roundCount();

        Configure configure = new Configure();
        configure.setDeploymentsDir(string.concat(BASE_DIR, "/idempotent"));
        configure.configureAt(path, operator);

        assertEq(draw.poolCount(), poolCountBefore, "no pool was created twice");
        assertEq(draw.roundCount(), roundCountBefore, "no round was opened twice");
        assertEq(vault.owner(), operator, "ownership transfer was not repeated");
        assertEq(vault.pendingOwner(), draw.pendingOwner(), "both transfers still pending at the final owner");
        assertEq(vm.readFile(path), before, "the manifest is byte-identical");
        assertEq(verifier.verifyManifestAt(path), 0, "Verify still passes");
    }

    // ---------------------------------------------------------------------
    // Documents that must be refused
    // ---------------------------------------------------------------------

    function test_ReaderRefusesATemplateDocument() public {
        _deployLocal("template");
        string memory path = string.concat(BASE_DIR, "/template/31337/marked.plan.json");
        vm.writeFile(path, vm.readFile(local.planPath()));
        vm.writeJson("true", path, ".template");

        vm.expectRevert(
            bytes(string.concat("DeploymentLib: refusing a template document (\"template\": true): ", path))
        );
        this.readDocumentExternal(path);
    }

    function test_ShippedTestnetTemplateIsRefused() public {
        string memory path = "./script/templates/testnet.plan.example.json";
        vm.expectRevert(
            bytes(string.concat("DeploymentLib: refusing a template document (\"template\": true): ", path))
        );
        this.readDocumentExternal(path);
    }

    function test_ShippedMainnetTemplateIsRefused() public {
        string memory path = "./script/templates/mainnet.plan.example.json";
        vm.expectRevert(
            bytes(string.concat("DeploymentLib: refusing a template document (\"template\": true): ", path))
        );
        this.readDocumentExternal(path);
    }

    function test_ReaderRefusesAMissingDocument() public {
        string memory path = string.concat(BASE_DIR, "/absent/31337/absent.plan.json");
        vm.expectRevert(bytes(string.concat("DeploymentLib: no such deployment document: ", path)));
        this.readDocumentExternal(path);
    }

    function test_VerifyRejectsLateStartAndDeploymentBlocks() public {
        string memory path = _deployLocal("history-blocks");
        vm.roll(block.number + 100);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        m.chain.startBlock = block.number;
        m.vault.deployBlock = block.number;
        m.draw.deployBlock = block.number;
        DeploymentLib.writeDocument(m, path, false);
        assertEq(verifier.verifyManifestAt(path), 3, "both deployment blocks and scan start fail");
    }

    function test_VerifyRejectsMissingAndUnknownReceipts() public {
        string memory path = _deployLocal("history-missing");
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        bytes32 hash = m.vault.deployTx;
        m.vault.deployTx = bytes32(0);
        DeploymentLib.writeDocument(m, path, false);
        vm.expectRevert("History: missing deployTx; run Finalize first");
        verifier.verifyManifestAt(path);
        m.vault.deployTx = hash;
        DeploymentLib.writeDocument(m, path, false);
        verifier.setResponse("eth_getTransactionReceipt", string.concat('["', vm.toString(hash), '"]'), "null");
        vm.expectRevert("History: deployment receipt not found");
        verifier.verifyManifestAt(path);
    }

    function test_VerifyRejectsOrphanedReceipt() public {
        string memory path = _deployLocal("history-orphan");
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        string memory number = vm.toString(bytes32(m.vault.deployBlock));
        verifier.setResponse(
            "eth_getBlockByNumber",
            string.concat('["', number, '",false]'),
            string.concat('{"number":"', number, '","hash":"', vm.toString(bytes32(uint256(999))), '"}')
        );
        vm.expectRevert("History: deployment receipt is not canonical");
        verifier.verifyManifestAt(path);
    }

    function test_VerifyRejectsFailedOrSubstitutedReceipt() public {
        string memory path = _deployLocal("history-failed");
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        string memory params = string.concat('["', vm.toString(m.vault.deployTx), '"]');
        verifier.setResponse(
            "eth_getTransactionReceipt",
            params,
            string.concat(
                '{"transactionHash":"',
                vm.toString(m.vault.deployTx),
                '","contractAddress":"',
                vm.toString(m.vault.addr),
                '","status":"0x0"}'
            )
        );
        vm.expectRevert("History: deployment transaction failed");
        verifier.verifyManifestAt(path);
        verifier.setResponse(
            "eth_getTransactionReceipt",
            params,
            string.concat('{"transactionHash":"', vm.toString(bytes32(uint256(42))), '"}')
        );
        vm.expectRevert("History: transaction hash mismatch");
        verifier.verifyManifestAt(path);
    }

    function test_ConfigureRecoversOriginalRoundsAfterMultipleRollovers() public {
        string memory path = _deployLocal("resume-rollover");
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        uint256[KIND_COUNT] memory original;
        for (uint256 k = 0; k < KIND_COUNT; ++k) {
            original[k] = m.assets[0].pool.firstRoundIds[k];
        }
        for (uint256 i = 0; i < 2; ++i) {
            uint256 current = draw.getCurrent(1, Kind.Day100);
            vm.warp(draw.getRound(current).closesAt);
            draw.closeRound(current);
        }
        // Exercise a partially populated record. Blank a weekly and a monthly id, not a second daily one:
        // recovery walks back to sequence 1 from the pointer of that kind, and only a non-daily kind proves
        // it uses that kind's own cadence rather than the daily rollover it just watched (ADR 036).
        m.assets[0].pool.firstRoundIds[uint256(Kind.Week10k)] = 0;
        m.assets[0].pool.firstRoundIds[uint256(Kind.Month100k)] = 0;
        DeploymentLib.writeDocument(m, path, false);
        Configure configure = new Configure();
        configure.setDeploymentsDir(string.concat(BASE_DIR, "/resume-rollover"));
        configure.configureAt(path, operator);
        m = DeploymentLib.readDocument(path);
        for (uint256 k = 0; k < KIND_COUNT; ++k) {
            assertEq(m.assets[0].pool.firstRoundIds[k], original[k], "every first round id is recovered");
        }
        assertEq(verifier.verifyManifestAt(path), 0);
    }

    function test_MetadataSurvivesPlanConfigureAndFinalize() public {
        string memory path = _deployLocal("metadata");
        string memory plan = local.planPath();
        vm.writeJson('"finalized"', plan, ".chain.finalityTag");
        vm.writeJson(
            '{"genesisHash":null,"multicall3":"0xca11bde05977b3631167028862be2a173976ca11","source":{"url":null,"date":null}}',
            plan,
            ".chain.networkIdentity"
        );
        vm.writeJson('""', plan, ".chain.notes");
        vm.writeJson(
            '[{"role":"owner","threshold":2,"signerCount":3,"hardwareKeys":true,"modulesEnabled":false,"guardEnabled":false,"withdrawalSchedule":null}]',
            plan,
            ".ownership.safes"
        );
        // Array-element insertion is unsupported by writeJson; insert through the serialized text instead.
        _replaceInFile(
            plan,
            '"symbol": "TEST2"',
            '"notes":"Issuer review retained", "issuerReview":{"upgradeable":false,"freezeOrBlocklist":true,"mintAuthority":"issuer","rebasing":false,"reviewedOn":null,"source":{"url":null,"date":null}}, "symbol": "TEST2"'
        );
        DeploymentLib.Manifest memory source = DeploymentLib.readDocument(plan);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        m.chainExtras = source.chainExtras;
        m.ownershipExtras = source.ownershipExtras;
        m.assetExtras = source.assetExtras;
        m.poolExtras = source.poolExtras;
        DeploymentLib.writeDocument(source, plan, true);
        _assertMetadata(plan);
        DeploymentLib.writeDocument(m, path, false);
        Configure configure = new Configure();
        configure.setDeploymentsDir(string.concat(BASE_DIR, "/metadata"));
        configure.configureAt(path, operator);
        _assertMetadata(path);
        FinalizeHarness finalizer = new FinalizeHarness();
        finalizer.seedManifest(path);
        string memory broadcast = string.concat(BASE_DIR, "/metadata/receipts.json");
        vm.writeFile(broadcast, _broadcastReceipts(m));
        finalizer.finalizeAt(path, broadcast);
        _assertMetadata(path);
        assertEq(verifier.verifyManifestAt(path), 0);
    }

    /// @dev The operator writes `release` after Finalize (SPEC section 14: private shakedown, then
    ///      `customerLaunch`). A later idempotent Configure re-run or a Finalize repeat rewrites the manifest and
    ///      must carry it, including a null shakedown and an absent optional number.
    function test_ReleaseRecordSurvivesConfigureAndFinalize() public {
        string memory path = _deployLocal("release");
        _replaceInFile(
            path,
            '"mocks":',
            '"release":{"customerLaunch":false,"shakedown":{"performed":true,"date":"2026-09-20","roundIds":[1,2],"callbackGasUsed":123456,"requestToFulfilmentSeconds":null,"costPerDrawNativeWei":"12345678900000000"}}, "mocks":'
        );
        Configure configure = new Configure();
        configure.setDeploymentsDir(string.concat(BASE_DIR, "/release"));
        configure.configureAt(path, operator);
        _assertRelease(path);
        FinalizeHarness finalizer = new FinalizeHarness();
        finalizer.seedManifest(path);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        string memory broadcast = string.concat(BASE_DIR, "/release/receipts.json");
        vm.writeFile(broadcast, _broadcastReceipts(m));
        finalizer.finalizeAt(path, broadcast);
        _assertRelease(path);
        assertEq(verifier.verifyManifestAt(path), 0, "Verify ignores the release record");

        // A null shakedown survives too, and the plan shape never carries `release`.
        vm.writeJson("null", path, ".release.shakedown");
        vm.writeJson("true", path, ".release.customerLaunch");
        DeploymentLib.Manifest memory again = DeploymentLib.readDocument(path);
        DeploymentLib.writeDocument(again, path, false);
        string memory json = vm.readFile(path);
        assertTrue(vm.parseJsonBool(json, ".release.customerLaunch"));
        assertTrue(vm.keyExistsJson(json, ".release.shakedown"));
        assertEq(vm.parseJsonString(json, ".release.shakedown"), "null");
        string memory planPath = string.concat(BASE_DIR, "/release/as-plan.json");
        DeploymentLib.writeDocument(again, planPath, true);
        assertFalse(vm.keyExistsJson(vm.readFile(planPath), ".release"));
    }

    function _assertRelease(string memory path) private view {
        string memory json = vm.readFile(path);
        assertFalse(vm.parseJsonBool(json, ".release.customerLaunch"));
        assertTrue(vm.parseJsonBool(json, ".release.shakedown.performed"));
        assertEq(vm.parseJsonString(json, ".release.shakedown.date"), "2026-09-20");
        uint256[] memory ids = vm.parseJsonUintArray(json, ".release.shakedown.roundIds");
        assertEq(ids.length, 2);
        assertEq(ids[1], 2);
        assertEq(vm.parseJsonUint(json, ".release.shakedown.callbackGasUsed"), 123456);
        assertEq(vm.parseJsonString(json, ".release.shakedown.requestToFulfilmentSeconds"), "null");
        assertEq(vm.parseJsonString(json, ".release.shakedown.costPerDrawNativeWei"), "12345678900000000");
    }

    /// @dev A creation dropped by a reorg and re-included at a different height leaves the local broadcast file
    ///      naming the old block. The transaction hash is all the file has to supply: `DeploymentHistory`
    ///      authenticates the receipt and its canonical block, so the receipt's height is the authority and the
    ///      stale one is corrected with a notice instead of refused forever.
    function test_FinalizeCorrectsAStaleBroadcastBlockFromTheCanonicalReceipt() public {
        string memory path = _deployLocal("finalize-stale-block");
        FinalizeHarness finalizer = new FinalizeHarness();
        finalizer.seedManifest(path);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        uint256 canonicalVaultBlock = m.vault.deployBlock;
        uint256 canonicalDrawBlock = m.draw.deployBlock;

        m.vault.deployBlock += 1; // the broadcast file's copy of the height, now stale
        string memory broadcast = string.concat(BASE_DIR, "/finalize-stale-block/receipts.json");
        vm.writeFile(broadcast, _broadcastReceipts(m));
        finalizer.finalizeAt(path, broadcast);

        DeploymentLib.Manifest memory updated = DeploymentLib.readDocument(path);
        assertEq(updated.vault.deployBlock, canonicalVaultBlock, "the canonical receipt's block is written");
        assertEq(updated.draw.deployBlock, canonicalDrawBlock, "the Draw block is unchanged");
        assertEq(updated.vault.deployTx, m.vault.deployTx, "the transaction hash came from the broadcast file");
        assertEq(updated.chain.startBlock, canonicalVaultBlock, "the scan lower bound follows the receipts");
        assertEq(verifier.verifyManifestAt(path), 0, "Verify passes on the corrected manifest");
    }

    function _broadcastReceipts(DeploymentLib.Manifest memory m) private view returns (string memory) {
        return string.concat(
            '{"chain":31337,"receipts":[{"contractAddress":null},',
            '{"contractAddress":"',
            vm.toString(m.vault.addr),
            '","transactionHash":"',
            vm.toString(m.vault.deployTx),
            '","blockNumber":"',
            vm.toString(bytes32(m.vault.deployBlock)),
            '"},',
            '{"contractAddress":"',
            vm.toString(m.draw.addr),
            '","transactionHash":"',
            vm.toString(m.draw.deployTx),
            '","blockNumber":"',
            vm.toString(bytes32(m.draw.deployBlock)),
            '"}]}'
        );
    }

    function _assertMetadata(string memory path) private view {
        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonString(json, ".chain.finalityTag"), "finalized");
        assertEq(vm.parseJsonString(json, ".chain.notes"), "");
        assertEq(
            vm.parseJsonAddress(json, ".chain.networkIdentity.multicall3"), 0xcA11bde05977b3631167028862bE2a173976CA11
        );
        assertEq(vm.parseJsonUint(json, ".ownership.safes[0].threshold"), 2);
        assertFalse(vm.keyExistsJson(json, ".ownership.safes[0].implementation"));
        assertTrue(vm.parseJsonBool(json, ".assets[1].issuerReview.freezeOrBlocklist"));
        assertEq(vm.parseJsonString(json, ".assets[1].notes"), "Issuer review retained");
    }

    // ---------------------------------------------------------------------
    // price.observationWindow (mainnet validator rule P8)
    // ---------------------------------------------------------------------

    /// @dev `observationWindow` is the provenance of `observedP999IntervalSeconds`, required by the validator on
    ///      mainnet and absent from `PriceSpec`. A rewrite that dropped it deleted a hand-added one on every
    ///      Configure or Finalize run, so the manifest failed rule P8 after the deployment gas was already spent.
    function test_ObservationWindowSurvivesConfigureAndFinalize() public {
        string memory path = _deployLocal("observation-window");
        // `vm.writeJson` cannot address an array element, so the record is inserted as text into both assets.
        _replaceInFile(
            path,
            '"answerBoundsConfirmedAbsent"',
            '"observationWindow":{"fromBlock":1,"toBlock":2,"samples":3}, "answerBoundsConfirmedAbsent"'
        );
        _assertObservationWindow(path);

        Configure configure = new Configure();
        configure.setDeploymentsDir(string.concat(BASE_DIR, "/observation-window"));
        configure.configureAt(path, operator);
        _assertObservationWindow(path);

        FinalizeHarness finalizer = new FinalizeHarness();
        finalizer.seedManifest(path);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        string memory broadcast = string.concat(BASE_DIR, "/observation-window/receipts.json");
        vm.writeFile(broadcast, _broadcastReceipts(m));
        finalizer.finalizeAt(path, broadcast);
        _assertObservationWindow(path);

        assertEq(verifier.verifyManifestAt(path), 0, "Verify ignores the observation window");
    }

    /// @dev M3: `requiresZeroReset` (SPEC section 9.5) is optional and false when absent, so a rewrite that dropped
    ///      it silently turned a token needing approve(0)-then-approve(amount) back into a single-approve token on
    ///      the next Configure run. Injected as true on the ERC-20 asset, it must survive Configure and Finalize; a
    ///      native asset may never carry it as true (validator rule A9), so assets[0] stays false.
    function test_RequiresZeroResetSurvivesConfigureAndFinalize() public {
        string memory path = _deployLocal("zero-reset");
        // `vm.writeJson` cannot address an array element, so the flag is set as text on the ERC-20 asset alone:
        // everything after its `symbol` is that asset, and `requiresZeroReset` is written just after it.
        string[] memory parts = vm.split(vm.readFile(path), '"symbol": "TEST2"');
        assertEq(parts.length, 2, "TEST2 names the second asset once");
        vm.writeFile(
            path,
            string.concat(
                parts[0],
                '"symbol": "TEST2"',
                vm.replace(parts[1], '"requiresZeroReset": false', '"requiresZeroReset": true')
            )
        );
        _assertRequiresZeroReset(path);

        Configure configure = new Configure();
        configure.setDeploymentsDir(string.concat(BASE_DIR, "/zero-reset"));
        configure.configureAt(path, operator);
        _assertRequiresZeroReset(path);

        FinalizeHarness finalizer = new FinalizeHarness();
        finalizer.seedManifest(path);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        assertTrue(m.assets[1].requiresZeroReset, "the reader sees the flag");
        assertFalse(m.assets[0].requiresZeroReset, "and the native asset is false");
        string memory broadcast = string.concat(BASE_DIR, "/zero-reset/receipts.json");
        vm.writeFile(broadcast, _broadcastReceipts(m));
        finalizer.finalizeAt(path, broadcast);
        _assertRequiresZeroReset(path);

        assertEq(verifier.verifyManifestAt(path), 0, "Verify ignores the flag");
    }

    function _assertRequiresZeroReset(string memory path) private view {
        string memory json = vm.readFile(path);
        assertTrue(vm.parseJsonBool(json, ".assets[1].requiresZeroReset"), "the ERC-20 asset keeps requiresZeroReset");
        assertFalse(vm.parseJsonBool(json, ".assets[0].requiresZeroReset"), "the native asset carries it as false");
    }

    /// @dev The null form is what a filled plan carries until `scripts/observe_feed.ts` has been run, and it is what
    ///      the shipped mainnet form ships; an absent key and an explicit null are not the same document.
    function test_NullObservationWindowSurvivesAPlanRoundTrip() public {
        _deployLocal("observation-window-null");
        string memory plan = local.planPath();
        _replaceInFile(plan, '"answerBoundsConfirmedAbsent"', '"observationWindow":null, "answerBoundsConfirmedAbsent"');
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(plan);
        DeploymentLib.writeDocument(m, plan, true);

        string memory json = vm.readFile(plan);
        for (uint256 i = 0; i < 2; ++i) {
            string memory at = string.concat(".assets[", vm.toString(i), "].price.observationWindow");
            assertTrue(vm.keyExistsJson(json, at), "the null record survives as a key");
            assertEq(vm.parseJsonString(json, at), "null", "and it is still null");
        }
    }

    /// @dev The shipped mainnet form, filled in the way the runbook asks and with its `template` flag deleted, is
    ///      the document an operator actually deploys. `Deploy` writes the manifest from it without rereading the
    ///      file, so whatever this round trip drops is gone from the manifest the validator later sees.
    function test_FilledMainnetTemplateKeepsObservationWindow() public {
        string memory source = vm.readFile("./script/templates/mainnet.plan.example.json");
        assertTrue(vm.keyExistsJson(source, ".assets[0].price.observationWindow"), "the shipped form carries the field");
        string memory dir = string.concat(BASE_DIR, "/mainnet-form");
        vm.createDir(dir, true);
        string memory path = string.concat(dir, "/mainnet.plan.json");
        // Delete the template flag and fill the nulls the reader requires; nothing else is touched.
        string memory filled = vm.replace(source, '  "template": true,\n', "");
        filled =
            vm.replace(filled, '"coordinator": null', '"coordinator": "0x00000000000000000000000000000000000c0001"');
        filled = vm.replace(filled, '"finalOwner": null', '"finalOwner": "0x0000000000000000000000000000000000000f01"');
        filled = vm.replace(filled, '"feeAccount": null', '"feeAccount": "0x0000000000000000000000000000000000000f02"');
        filled =
            vm.replace(filled, '"seedAccount": null', '"seedAccount": "0x0000000000000000000000000000000000000f03"');
        filled = vm.replace(filled, '"feed": null', '"feed": "0x0000000000000000000000000000000000000fee"');
        filled = vm.replace(
            filled,
            '"observationWindow": null',
            '"observationWindow": {"fromBlock":900000,"toBlock":1000000,"samples":4321}'
        );
        vm.writeFile(path, filled);

        DeploymentLib.Manifest memory plan = DeploymentLib.readDocument(path);
        assertEq(plan.environment, "mainnet", "the filled form reads as a mainnet plan");
        string memory out = string.concat(dir, "/round-trip.plan.json");
        DeploymentLib.writeDocument(plan, out, true);

        string memory json = vm.readFile(out);
        assertEq(vm.parseJsonUint(json, ".assets[0].price.observationWindow.fromBlock"), 900_000, "fromBlock");
        assertEq(vm.parseJsonUint(json, ".assets[0].price.observationWindow.toBlock"), 1_000_000, "toBlock");
        assertEq(vm.parseJsonUint(json, ".assets[0].price.observationWindow.samples"), 4321, "samples");
    }

    function _assertObservationWindow(string memory path) private view {
        string memory json = vm.readFile(path);
        for (uint256 i = 0; i < 2; ++i) {
            string memory at = string.concat(".assets[", vm.toString(i), "].price.observationWindow");
            assertEq(vm.parseJsonUint(json, string.concat(at, ".fromBlock")), 1, "fromBlock");
            assertEq(vm.parseJsonUint(json, string.concat(at, ".toBlock")), 2, "toBlock");
            assertEq(vm.parseJsonUint(json, string.concat(at, ".samples")), 3, "samples");
        }
    }

    // ---------------------------------------------------------------------
    // Schema-illegal `release` spellings the reader must not repair
    // ---------------------------------------------------------------------

    /// @dev `parseJsonBool` coerces the JSON string "true", so one Configure run turned a manifest that both
    ///      `validate_config.ts` and the Pages gate reject into one they accept. The reader refuses it instead.
    function test_ReaderRefusesAStringCustomerLaunch() public {
        _assertReleaseRefused(
            "release-string-launch",
            '"release":{"customerLaunch":"true","shakedown":null}, "mocks":',
            "DeploymentLib: release.customerLaunch must be a JSON boolean, not a string"
        );
    }

    /// @dev `parseJsonUint` coerces a quoted number the same way, and the shakedown numbers are measurements.
    function test_ReaderRefusesAStringShakedownNumber() public {
        _assertReleaseRefused(
            "release-string-number",
            '"release":{"customerLaunch":false,"shakedown":{"performed":true,"date":null,"roundIds":[1],'
            '"callbackGasUsed":"123456","requestToFulfilmentSeconds":null,"costPerDrawNativeWei":null}}, "mocks":',
            "DeploymentLib: release.shakedown.callbackGasUsed must be a JSON number, not a string"
        );
    }

    /// @dev A null `release` was rewritten into `{}`, which the schema rejects for missing both required fields.
    function test_ReaderRefusesANullRelease() public {
        _assertReleaseRefused(
            "release-null",
            '"release":null, "mocks":',
            "DeploymentLib: release must be an object with customerLaunch, not null"
        );
    }

    /// @dev A shakedown object missing `performed` was rewritten into `null`, erasing the record it did carry.
    function test_ReaderRefusesAShakedownWithoutPerformed() public {
        _assertReleaseRefused(
            "release-no-performed",
            '"release":{"customerLaunch":false,"shakedown":{"date":"2026-09-20","roundIds":[1]}}, "mocks":',
            "DeploymentLib: release.shakedown must be null or an object with performed"
        );
    }

    /// @dev Injects a `release` record into a local manifest, asserts the reader refuses it, and asserts that the
    ///      refusal left the file exactly as the operator wrote it.
    function _assertReleaseRefused(string memory tag, string memory release, string memory reason) private {
        string memory path = _deployLocal(tag);
        _replaceInFile(path, '"mocks":', release);
        string memory before = vm.readFile(path);
        vm.expectRevert(bytes(reason));
        this.readDocumentExternal(path);
        assertEq(vm.readFile(path), before, "the refused document is untouched");
    }

    /// @notice External wrapper so `vm.expectRevert` has a call to attach to.
    /// @param path The document to read.
    function readDocumentExternal(string memory path) external view {
        DeploymentLib.readDocument(path);
    }

    /// @dev Edits a document as text, for the array elements `vm.writeJson`'s key form cannot address.
    function _replaceInFile(string memory path, string memory from, string memory to) private {
        vm.writeFile(path, vm.replace(vm.readFile(path), from, to));
    }

    /// @dev Every file this repository writes is LF and ends with a newline (`.gitattributes`, config/README.md).
    function _assertLfTerminated(string memory path) private view {
        bytes memory raw = bytes(vm.readFile(path));
        assertGt(raw.length, 0, "document is not empty");
        assertEq(raw[raw.length - 1], bytes1(0x0a), "document ends with a newline");
        for (uint256 j = 0; j < raw.length; ++j) {
            assertTrue(raw[j] != bytes1(0x0d), "document has no CR bytes");
        }
    }
}
