// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {LuckyDraw} from "../src/LuckyDraw.sol";
import {LuckyVault} from "../src/LuckyVault.sol";
import {KIND_COUNT, NATIVE_ASSET, ReferenceKind} from "../src/Types.sol";
import {MockAggregatorV3} from "../test/mocks/MockAggregatorV3.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockVRFCoordinatorV2Plus} from "../test/mocks/MockVRFCoordinatorV2Plus.sol";
import {ConfigureBase} from "./Configure.s.sol";
import {DeployBase} from "./Deploy.s.sol";
import {DeploymentLib} from "./DeploymentLib.sol";

/// @title DeployLocal
/// @notice The local profile of SPEC §12: labeled mocks, no secrets, no invented production addresses.
/// @dev "No need to invent deployment addresses or write secrets to make a sample build run: local profile uses mocks
///      and clearly labeled assets." This script deploys those mocks, writes the plan it derived from them, and then
///      runs exactly the same `DeployBase` and `ConfigureBase` code paths a testnet or mainnet deployment runs, so
///      the local run is evidence about the real scripts and not about a parallel implementation.
///
///      The asset, price and chain facts it writes are the ones already recorded in `config/assets/31337/` and
///      `config/chains/31337.json`; only the addresses, which exist just once the mocks are deployed, are added here.
///
///      Deliberately refuses to run anywhere but chain 31337: mocks must be impossible in a production manifest
///      (ACCEPTANCE "Deployment" evidence, validator rules M1 and D4).
contract DeployLocal is DeployBase, ConfigureBase {
    /// @notice Anvil's second default account, used as the labeled stand-in for the operator multisig.
    address internal constant ANVIL_FINAL_OWNER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    /// @notice Anvil's third default account, used as the labeled stand-in for the treasury Safe.
    address internal constant ANVIL_FEE_ACCOUNT = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    /// @notice Anvil's fourth default account, used as the labeled stand-in for the seed Safe.
    address internal constant ANVIL_SEED_ACCOUNT = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;

    /// @notice The only chain this script may touch.
    uint256 internal constant LOCAL_CHAIN_ID = 31337;

    /// @notice The local gas lane. A mock hash: no BSC key hash is invented anywhere in this repository.
    bytes32 internal constant LOCAL_KEY_HASH = keccak256("luckydraw.local.gaslane");

    /// @notice SPEC §7.1 fixed request parameters.
    uint256 internal constant CONFIRMATIONS = 200;
    uint256 internal constant CALLBACK_GAS_LIMIT = 300_000;

    /// @notice Illustrative local derivation of `maxRequestCostNative` (SPEC §7.1, §15).
    uint256 internal constant LOCAL_MAX_GAS_PRICE_WEI = 5 gwei;
    uint256 internal constant LOCAL_VERIFICATION_OVERHEAD = 115_000;
    uint256 internal constant LOCAL_PREMIUM_PERCENT = 50;
    uint256 internal constant LOCAL_FLAT_FEE_WEI = 0.0005 ether;

    /// @notice Local subscription funding, comfortably above the low-funding threshold.
    uint96 internal constant LOCAL_SUBSCRIPTION_BALANCE = 1 ether;

    /// @notice Local seed amounts in raw units: 0.01 BNB and 5.00 TEST2.
    uint256 internal constant SEED_NATIVE = 0.01 ether;
    uint256 internal constant SEED_TEST2 = 500;

    /// @notice The per-round caps the local seed account authorizes for itself, one per asset and in that
    ///         asset's own raw units (SPEC §5.4: pointing is not consent, and consent is per asset).
    uint256 internal constant SEED_AUTHORIZED_MAX = 0.01 ether;
    uint256 internal constant SEED_AUTHORIZED_MAX_TEST2 = 500;

    /// @notice Whole-USD targets per `Kind`, the contract defaults (SPEC §6.1, ADR 036).
    function _defaultTargets() internal pure returns (uint256[KIND_COUNT] memory t) {
        t = [uint256(100), 1000, 10_000, 1000, 10_000, 100_000, 100_000];
    }

    /// @notice The deployed pair and mocks, exposed for the in-process script tests.
    LuckyVault public vault;
    LuckyDraw public draw;
    MockVRFCoordinatorV2Plus public coordinator;
    MockAggregatorV3 public nativeFeed;
    MockAggregatorV3 public tokenFeed;
    MockERC20 public token;
    uint256 public subscriptionId;
    string public planPath;
    string public manifestPathWritten;

    /// @notice Deploys the mocks, the pair and the configuration, and writes the local manifest.
    /// @return path The manifest path under `<deployments dir>/31337/`.
    function run() external returns (string memory path) {
        return runAs(msg.sender);
    }

    /// @notice The same run on behalf of an explicit account.
    /// @dev Separated from `run` because the in-process tests cannot use `vm.prank` to choose the sender:
    ///      `vm.startBroadcast` refuses to run under an active prank.
    /// @param broadcaster The deploying operator address; becomes the initial owner of both contracts.
    /// @return path The manifest path under `<deployments dir>/31337/`.
    function runAs(address broadcaster) public returns (string memory path) {
        require(
            block.chainid == LOCAL_CHAIN_ID,
            string.concat("DeployLocal: refuses to run on chain ", vm.toString(block.chainid), "; expected 31337")
        );

        _deployMocks(broadcaster);

        DeploymentLib.Manifest memory plan = _buildPlan();
        planPath = string.concat(_deploymentsDir(), "/", vm.toString(LOCAL_CHAIN_ID), "/local.plan.json");
        DeploymentLib.writeDocument(plan, planPath, true);
        console2.log("DeployLocal: plan", planPath);

        // Read the plan back through the production parser: the local run then exercises the same path a testnet
        // deployment takes, including the schema, the null handling and the required-field checks.
        DeploymentLib.Manifest memory parsed = DeploymentLib.readDocument(planPath);

        (DeploymentLib.Manifest memory manifest, LuckyVault v, LuckyDraw d) = _deployFromPlan(parsed, broadcaster);
        vault = v;
        draw = d;

        // A plan may not name mock artifacts (the plan schema forbids `mocks`); the manifest must, because that list
        // is what makes a local deployment recognisable and a production one refusable (SPEC §12).
        manifest.mocks = _mockArtifacts();
        manifest.notes = "Local mock deployment written by contracts/script/DeployLocal.s.sol. Every asset, price feed"
            " and the VRF coordinator is a labeled mock and none of them may appear in a testnet or mainnet manifest.";
        DeploymentLib.writeManifest(manifest, _deploymentsDir());

        // The operator registers the consumer on the subscription between deployment and configuration; the mock
        // coordinator stands in for that action here (SPEC §7.3 consumer registration receipt).
        vm.startBroadcast(broadcaster);
        coordinator.addConsumer(subscriptionId, address(d));
        vm.stopBroadcast();
        console2.log("DeployLocal: consumer registered on subscription", subscriptionId);

        // The first configuration pass lists the assets and opens the pools; consent can only be given for a
        // listed asset, so it cannot come earlier.
        manifest = _configureFromManifest(manifest, broadcaster);

        // Seed consent belongs to the seed account itself and no owner can grant it, and it is per asset in
        // that asset's raw units (SPEC §5.4, D9). On anvil the labeled seed account is unlocked, so the local
        // stack ends up actually able to seed a lone-player round in either pool.
        vm.startBroadcast(manifest.ownership.seedAccount);
        v.authorizeSeed(NATIVE_ASSET, SEED_AUTHORIZED_MAX);
        v.authorizeSeed(address(token), SEED_AUTHORIZED_MAX_TEST2);
        vm.stopBroadcast();
        console2.log("DeployLocal: seed account authorized for BNB up to", SEED_AUTHORIZED_MAX);
        console2.log("DeployLocal: seed account authorized for TEST2 up to", SEED_AUTHORIZED_MAX_TEST2);

        // Configuration is idempotent, so the second pass changes nothing on chain and only records the caps
        // the seed account just granted, exactly as an operator re-runs Configure after the Safe consents.
        manifest = _configureFromManifest(manifest, broadcaster);
        console2.log("DeployLocal: fund the seed account's Vault balance before it can actually seed a round");

        manifestPathWritten = DeploymentLib.manifestPath(_deploymentsDir(), manifest.chain.chainId, manifest.draw.addr);
        return manifestPathWritten;
    }

    /// @notice Deploys the labeled mocks: a 2-decimal token, two feeds and a VRF coordinator with a funded lane.
    /// @param broadcaster The deploying account, which also owns the mock subscription.
    function _deployMocks(address broadcaster) internal {
        vm.startBroadcast(broadcaster);
        token = new MockERC20("LuckyDraw Test Token", "TEST2", 2);
        nativeFeed = new MockAggregatorV3(8);
        nativeFeed.set(1, 600e8, block.timestamp);
        tokenFeed = new MockAggregatorV3(8);
        tokenFeed.set(1, 1e8, block.timestamp);

        coordinator = new MockVRFCoordinatorV2Plus();
        subscriptionId = coordinator.createSubscription();
        coordinator.registerKey(LOCAL_KEY_HASH, uint64(LOCAL_MAX_GAS_PRICE_WEI));
        coordinator.fundNative(subscriptionId, LOCAL_SUBSCRIPTION_BALANCE);
        vm.stopBroadcast();

        console2.log("DeployLocal: MockERC20 TEST2", address(token));
        console2.log("DeployLocal: MockAggregatorV3 BNB/USD 600.00", address(nativeFeed));
        console2.log("DeployLocal: MockAggregatorV3 TEST2/USD 1.00", address(tokenFeed));
        console2.log("DeployLocal: MockVRFCoordinatorV2Plus", address(coordinator));
    }

    /// @notice Builds the local deployment plan from the mocks just deployed.
    /// @return plan The plan document.
    function _buildPlan() internal view returns (DeploymentLib.Manifest memory plan) {
        plan.schemaVersion = DeploymentLib.SCHEMA_VERSION;
        plan.name = "local";
        plan.environment = "local";
        plan.notes = "Written by contracts/script/DeployLocal.s.sol from the mocks it had just deployed. Regenerated"
            " on every local run; the addresses change with the deployer nonce.";
        plan.chain = DeploymentLib.ChainSpec({
            chainId: LOCAL_CHAIN_ID,
            name: "anvil-local",
            nativeSymbol: "BNB",
            explorerUrl: "",
            confirmationDepth: 200,
            startBlock: 0,
            rpcEnvPublic: "LUCKYDRAW_RPC_URL",
            rpcEnvOperational: "LUCKYDRAW_OPS_RPC_URL"
        });

        uint256 maxRequestCost = _localMaxRequestCost();
        plan.vrf = DeploymentLib.VrfSpec({
            coordinator: address(coordinator),
            coordinatorIsMock: true,
            subscriptionId: subscriptionId,
            subscriptionOwner: address(0),
            keyHash: LOCAL_KEY_HASH,
            requestConfirmations: CONFIRMATIONS,
            numWords: DeploymentLib.NUM_WORDS,
            callbackGasLimit: CALLBACK_GAS_LIMIT,
            maxRequestCostNative: maxRequestCost,
            derivation: DeploymentLib.Derivation({
                maxGasPriceWei: LOCAL_MAX_GAS_PRICE_WEI,
                verificationGasOverhead: LOCAL_VERIFICATION_OVERHEAD,
                premiumPercentage: LOCAL_PREMIUM_PERCENT,
                flatFeeNativeWei: LOCAL_FLAT_FEE_WEI,
                note: "Local placeholder, not a BSC lane: 5 gwei x (300000 + 115000) x 1.5 + 0.0005 BNB"
            }),
            consumerRegistered: false,
            consumerRegistrationTx: bytes32(0),
            lowFundingThresholdNative: maxRequestCost * 10,
            measuredCallbackGasUsed: 0,
            source: DeploymentLib.Source({url: "", date: ""})
        });

        plan.ownership = DeploymentLib.OwnershipSpec({
            finalOwner: vm.envOr("LUCKYDRAW_LOCAL_FINAL_OWNER", ANVIL_FINAL_OWNER),
            feeAccount: vm.envOr("LUCKYDRAW_LOCAL_FEE_ACCOUNT", ANVIL_FEE_ACCOUNT),
            seedAccount: vm.envOr("LUCKYDRAW_LOCAL_SEED_ACCOUNT", ANVIL_SEED_ACCOUNT),
            ownershipAccepted: false,
            makeWholeReserve: "",
            makeWholeCap: "",
            note: "Local mocks: labeled anvil accounts stand in for the owner, treasury and seed Safes. The final"
            " owner must accept both transfers and the seed account calls Vault.authorizeSeed itself."
        });

        plan.assets = new DeploymentLib.AssetSpec[](2);
        plan.assets[0] = DeploymentLib.AssetSpec({
            asset: NATIVE_ASSET,
            native: true,
            symbol: "BNB",
            name: "Local mock native BNB",
            decimals: 18,
            isMock: true,
            listed: false,
            depositsEnabled: true,
            exactTransferEvidence: "Native path: the Vault credits exactly msg.value and checks the exact debit on"
            " withdrawal, so no token transfer hook can change the amount (SPEC section 3.1).",
            requiresZeroReset: false,
            status: "mock-local",
            source: DeploymentLib.Source({url: "", date: ""}),
            price: DeploymentLib.PriceSpec({
                feed: address(nativeFeed),
                feedIsMock: true,
                feedDecimals: 8,
                baseQuote: "BNB/USD",
                heartbeatSeconds: 0, // a mock aggregator publishes none; maxPriceAge falls back to the 3600 floor
                observedP999IntervalSeconds: 0,
                maxPriceAge: 3600,
                minAnswer: 0,
                maxAnswer: 0,
                answerBoundsConfirmedAbsent: true,
                referenceKind: ReferenceKind.ExactToken,
                displayLabel: "",
                pegAssumption: "",
                verifiedOn: "",
                source: DeploymentLib.Source({url: "", date: ""})
            }),
            pool: DeploymentLib.PoolSpec({
                poolId: 0,
                enabled: true,
                seedAmount: SEED_NATIVE,
                seedAuthorizedMaxPerRound: "",
                targetsUsd: _defaultTargets(),
                firstRoundIds: [uint256(0), 0, 0, 0, 0, 0, 0]
            })
        });
        plan.assets[1] = DeploymentLib.AssetSpec({
            asset: address(token),
            native: false,
            symbol: "TEST2",
            name: "Local mock two-decimal ERC-20 for the second pool",
            decimals: 2,
            isMock: true,
            listed: false,
            depositsEnabled: true,
            exactTransferEvidence: "test/mocks/MockERC20.sol is a plain OpenZeppelin ERC-20: it transfers the exact"
            " amount and does not rebase.",
            requiresZeroReset: false,
            status: "mock-local",
            source: DeploymentLib.Source({url: "", date: ""}),
            price: DeploymentLib.PriceSpec({
                feed: address(tokenFeed),
                feedIsMock: true,
                feedDecimals: 8,
                baseQuote: "TEST2/USD",
                heartbeatSeconds: 1800, // exercises maxPriceAge = max(2H, 3600) where the floor still wins
                observedP999IntervalSeconds: 0,
                maxPriceAge: 3600,
                minAnswer: 0,
                maxAnswer: 0,
                answerBoundsConfirmedAbsent: true,
                referenceKind: ReferenceKind.ExactToken,
                displayLabel: "",
                pegAssumption: "",
                verifiedOn: "",
                source: DeploymentLib.Source({url: "", date: ""})
            }),
            pool: DeploymentLib.PoolSpec({
                poolId: 0,
                enabled: true,
                seedAmount: SEED_TEST2,
                seedAuthorizedMaxPerRound: "",
                targetsUsd: _defaultTargets(),
                firstRoundIds: [uint256(0), 0, 0, 0, 0, 0, 0]
            })
        });
    }

    /// @notice The labeled mock artifacts this deployment uses (SPEC §12; empty outside `local`).
    /// @return names The artifact names.
    function _mockArtifacts() internal pure returns (string[] memory names) {
        names = new string[](3);
        names[0] = "MockERC20";
        names[1] = "MockAggregatorV3";
        names[2] = "MockVRFCoordinatorV2Plus";
    }

    /// @notice The §7.1 worst-case request cost for the local lane.
    /// @return cost maxGasPrice x (callback + verification overhead) x (1 + premium) + flat fee, in wei.
    function _localMaxRequestCost() internal pure returns (uint256 cost) {
        cost = LOCAL_MAX_GAS_PRICE_WEI * (CALLBACK_GAS_LIMIT + LOCAL_VERIFICATION_OVERHEAD);
        cost = cost * (100 + LOCAL_PREMIUM_PERCENT) / 100;
        cost += LOCAL_FLAT_FEE_WEI;
    }
}
