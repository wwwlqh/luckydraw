// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {Configure} from "../../script/Configure.s.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeploymentLib} from "../../script/DeploymentLib.sol";
import {TestnetSafe} from "../../script/TestnetSafe.s.sol";
import {DeployLocalHarness} from "./DeploymentScriptGuards.t.sol";
import {VerifyHarness} from "./HistoryRpcFixture.sol";
import {MockSafe, MockSafeProxyFactory} from "../mocks/MockSafe.sol";
import {LuckyDraw} from "../../src/LuckyDraw.sol";
import {LuckyVault} from "../../src/LuckyVault.sol";

/// @notice `TestnetSafe.s.sol` against the labeled mock Safe: the single-Safe testnet handover, end to end.
/// @dev The real Safe v1.4.1 contracts are not vendored; `MockSafe` reproduces the pre-validated signature rule
///      and the GS013 failure revert the script relies on, so what is proven here is the script's control flow
///      (chain and layout guards, idempotence, the four owner actions through `execTransaction`) and the fact
///      that `Configure` and `Verify` then see the accepted state. The runbook's `cast` checks against the
///      canonical contracts on chain 97 remain the operator's.
contract TestnetSafeTest is Test {
    uint256 internal constant START = 1_789_128_000;
    string internal constant BASE_DIR = "./test/script/tmp/testnet-safe";
    uint256 internal constant DEPOSIT = 0.05 ether;

    DeployLocalHarness internal harness;
    Deploy internal deployer;
    Configure internal configure;
    VerifyHarness internal verifier;
    TestnetSafe internal script;
    MockSafeProxyFactory internal factory;
    MockSafe internal singleton;
    address internal operator;
    string internal planPath;

    function setUp() public {
        vm.warp(START);
        operator = makeAddr("operator");
        vm.deal(operator, 10 ether);
        factory = new MockSafeProxyFactory();
        singleton = new MockSafe();
        script = new TestnetSafe();
    }

    /// @dev The per-symbol cap overrides `ops()` reads from `SEED_MAX_PER_ROUND_<SYMBOL>`, passed directly: the
    ///      functions of one test contract run concurrently in a single process, so `vm.setEnv` would leak.
    function _override(string memory symbol, uint256 cap)
        internal
        pure
        returns (string[] memory symbols, uint256[] memory caps)
    {
        symbols = new string[](1);
        caps = new uint256[](1);
        symbols[0] = symbol;
        caps[0] = cap;
    }

    function _overrides(uint256 nativeCap, uint256 tokenCap)
        internal
        pure
        returns (string[] memory symbols, uint256[] memory caps)
    {
        symbols = new string[](2);
        caps = new uint256[](2);
        symbols[0] = "BNB";
        caps[0] = nativeCap;
        symbols[1] = "TEST2";
        caps[1] = tokenCap;
    }

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
        planPath = string.concat(dir, "/31337/", tag, ".plan.json");
    }

    function _createSafe(uint256 salt) internal returns (address safe) {
        return script.createFor(address(factory), address(singleton), address(singleton), salt, operator);
    }

    /// @dev Deploy and Configure with one Safe in all three roles, the layout the script drives.
    function _deployWithSafe(string memory tag, address safe) internal returns (string memory manifestPath) {
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        plan.name = tag;
        plan.ownership.finalOwner = safe;
        plan.ownership.feeAccount = safe;
        plan.ownership.seedAccount = safe;
        DeploymentLib.writeDocument(plan, planPath, true);
        manifestPath = deployer.deployPlanAt(planPath, operator);
        _register(manifestPath);
        _labelMocks(manifestPath);
        configure.configureAt(manifestPath, operator);
    }

    /// @dev `Deploy` on the anvil fixture does not know it deployed against mocks; `Verify` insists a local manifest
    ///      names them, so label the manifest the way `DeployLocal` would have.
    function _labelMocks(string memory manifestPath) internal {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        m.mocks = harness.mockArtifacts();
        DeploymentLib.writeDocument(m, manifestPath, false);
    }

    /// @dev What the operator does at vrf.chain.link between Deploy and Configure: add the Draw as a consumer.
    function _register(string memory manifestPath) internal {
        harness.coordinator().addConsumer(harness.subscriptionId(), DeploymentLib.readDocument(manifestPath).draw.addr);
    }

    // ---------------------------------------------------------------------
    // create
    // ---------------------------------------------------------------------

    function test_CreateDeploysAOneOfOneSafeOwnedByTheBroadcaster() public {
        address safe = _createSafe(1);
        MockSafe s = MockSafe(payable(safe));
        assertEq(s.getOwners().length, 1, "one owner");
        assertEq(s.getOwners()[0], operator, "the broadcaster");
        assertEq(s.getThreshold(), 1, "threshold");
        assertEq(s.VERSION(), "1.4.1", "version");
    }

    function test_CreateRefusesAFactoryOrSingletonWithoutCode() public {
        vm.expectRevert(bytes("TestnetSafe: SAFE_PROXY_FACTORY has no code on this chain"));
        script.createFor(address(0xF00), address(singleton), address(singleton), 1, operator);
        vm.expectRevert(bytes("TestnetSafe: SAFE_SINGLETON has no code on this chain"));
        script.createFor(address(factory), address(0xF00), address(singleton), 1, operator);
    }

    function test_CreateRefusesMainnet() public {
        vm.chainId(56);
        vm.expectRevert(
            bytes(
                "TestnetSafe: chain 56 is not BSC testnet (97); mainnet Safes are created in the Safe interface (SPEC 10.5)"
            )
        );
        script.createFor(address(factory), address(singleton), address(singleton), 1, operator);
    }

    // ---------------------------------------------------------------------
    // ops
    // ---------------------------------------------------------------------

    function test_OpsAcceptsOwnershipDepositsAndAuthorizesThroughTheSafe() public {
        _fixture("ops");
        address safe = _createSafe(2);
        string memory manifestPath = _deployWithSafe("ops", safe);
        DeploymentLib.Manifest memory before = DeploymentLib.readDocument(manifestPath);
        LuckyVault vault = LuckyVault(payable(before.vault.addr));
        LuckyDraw draw = LuckyDraw(before.draw.addr);
        assertEq(vault.pendingOwner(), safe, "ownership offered to the Safe");
        assertFalse(before.ownership.ownershipAccepted, "not accepted before ops");

        uint256 operatorBefore = operator.balance;
        script.opsAt(manifestPath, DEPOSIT, 0, operator);

        assertEq(vault.owner(), safe, "vault owned by the Safe");
        assertEq(draw.owner(), safe, "draw owned by the Safe");
        assertEq(vault.balanceOf(safe, address(0)), DEPOSIT, "seed balance deposited as the Safe");
        assertEq(operatorBefore - operator.balance, DEPOSIT, "the Safe was topped up from the broadcaster");
        for (uint256 i = 0; i < before.assets.length; i++) {
            assertEq(
                vault.seedMaxPerRound(safe, before.assets[i].asset),
                before.assets[i].pool.seedAmount,
                "cap defaults to seedAmount when the plan leaves it blank"
            );
        }

        // Configure re-reads the chain and records the accepted handover and the cap; Verify agrees.
        configure.configureAt(manifestPath, operator);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        assertTrue(m.ownership.ownershipAccepted, "ownership recorded as accepted");
        assertEq(m.vault.owner, safe, "manifest vault owner");
        assertEq(m.draw.owner, safe, "manifest draw owner");
        assertEq(m.assets[0].pool.seedAuthorizedMaxPerRound, vm.toString(m.assets[0].pool.seedAmount), "cap recorded");
        verifier.seedManifest(manifestPath);
        assertEq(verifier.verifyManifestAt(manifestPath), 0, "Verify passes after the handover");
    }

    function test_OpsIsIdempotentAndHonoursAnExplicitPerSymbolCap() public {
        _fixture("idempotent");
        address safe = _createSafe(3);
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        plan.name = "idempotent";
        plan.ownership.finalOwner = safe;
        plan.ownership.feeAccount = safe;
        plan.ownership.seedAccount = safe;
        DeploymentLib.writeDocument(plan, planPath, true);
        string memory manifestPath = deployer.deployPlanAt(planPath, operator);
        _register(manifestPath);
        configure.configureAt(manifestPath, operator);
        LuckyVault vault = LuckyVault(payable(DeploymentLib.readDocument(manifestPath).vault.addr));
        uint256 nativeCap = plan.assets[0].pool.seedAmount * 3;
        uint256 tokenCap = plan.assets[1].pool.seedAmount * 3;
        (string[] memory symbols, uint256[] memory caps) = _overrides(nativeCap, tokenCap);

        script.opsAt(manifestPath, DEPOSIT, 0, symbols, caps, operator);
        assertEq(vault.seedMaxPerRound(safe, address(0)), nativeCap, "explicit per-symbol cap, native");
        assertEq(vault.seedMaxPerRound(safe, plan.assets[1].asset), tokenCap, "explicit per-symbol cap, token");

        // Second run: nothing pending, balance already there, caps already set. No revert, one more deposit only
        // because a deposit is an amount, not a state.
        script.opsAt(manifestPath, 0, 0, symbols, caps, operator);
        assertEq(vault.owner(), safe, "still owned by the Safe");
        assertEq(vault.balanceOf(safe, address(0)), DEPOSIT, "no second deposit at SEED_DEPOSIT_WEI=0");
    }

    /// @dev M2: the chain 97 two-asset case. The plan there gives BNB a 2,000,000,000,000,000 wei cap and USDT a
    ///      10,000,000,000,000,000,000 raw-unit cap, which no single `SEED_MAX_PER_ROUND` can produce: one global
    ///      number would multiply the BNB cap by 5,000. The same shape here — a native cap in wei beside the
    ///      10,000,000,000,000,000,000 token cap — with each asset's cap taken from its own manifest entry, and a
    ///      global override that would land on both assets refused instead of silently applied.
    function test_OpsTakesEachAssetsCapFromItsOwnManifestEntry() public {
        _fixture("two-asset-caps");
        address safe = _createSafe(16);
        string memory manifestPath = _deployWithSafe("two-asset-caps", safe);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        uint256 nativeCap = m.assets[0].pool.seedAmount * 2;
        uint256 tokenCap = 10_000_000_000_000_000_000;
        _recordCaps(manifestPath, vm.toString(nativeCap), vm.toString(tokenCap));
        LuckyVault vault = LuckyVault(payable(m.vault.addr));
        script.opsAt(manifestPath, DEPOSIT, 0, operator);

        assertEq(vault.seedMaxPerRound(safe, m.assets[0].asset), nativeCap, "the native cap the manifest records");
        assertEq(vault.seedMaxPerRound(safe, m.assets[1].asset), tokenCap, "the token cap the manifest records");

        // A token-only run: the per-symbol override moves the token cap and leaves the native one exactly as it was.
        (string[] memory symbols, uint256[] memory caps) = _override("TEST2", tokenCap * 2);
        script.opsAt(manifestPath, 0, 0, symbols, caps, operator);
        assertEq(vault.seedMaxPerRound(safe, m.assets[1].asset), tokenCap * 2, "token cap raised");
        assertEq(vault.seedMaxPerRound(safe, m.assets[0].asset), nativeCap, "the native cap is untouched");
    }

    function test_OpsRefusesAGlobalCapThatWouldLandOnMoreThanOneAsset() public {
        _fixture("ambiguous-cap");
        address safe = _createSafe(17);
        string memory manifestPath = _deployWithSafe("ambiguous-cap", safe);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        uint256 global = m.assets[0].pool.seedAmount * 5;

        vm.expectRevert(
            bytes(
                "TestnetSafe: SEED_MAX_PER_ROUND would set the same raw cap on more than one asset (BNB, TEST2);"
                " give each one SEED_MAX_PER_ROUND_<SYMBOL> or record pool.seedAuthorizedMaxPerRound in the manifest"
            )
        );
        script.opsAt(manifestPath, 0, global, operator);

        // One asset already carries its own recorded cap, so the global override can only mean the other one.
        _recordCaps(manifestPath, vm.toString(m.assets[0].pool.seedAmount * 2), "");
        script.opsAt(manifestPath, 0, global, operator);
        LuckyVault vault = LuckyVault(payable(m.vault.addr));
        assertEq(vault.seedMaxPerRound(safe, m.assets[0].asset), m.assets[0].pool.seedAmount * 2, "recorded cap wins");
        assertEq(vault.seedMaxPerRound(safe, m.assets[1].asset), global, "the global override applies to the one left");
    }

    /// @dev Writes `pool.seedAuthorizedMaxPerRound` into the manifest the way `Configure` records it from the chain,
    ///      and the way the operator copies the plan entry of a new asset in (runbook §4a step 2). "" is blank.
    function _recordCaps(string memory manifestPath, string memory nativeCap, string memory tokenCap) internal {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        m.assets[0].pool.seedAuthorizedMaxPerRound = nativeCap;
        m.assets[1].pool.seedAuthorizedMaxPerRound = tokenCap;
        DeploymentLib.writeDocument(m, manifestPath, false);
    }

    function test_OpsRefusesACapBelowSeedAmount() public {
        _fixture("low-cap");
        address safe = _createSafe(4);
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        plan.name = "low-cap";
        plan.ownership.finalOwner = safe;
        plan.ownership.feeAccount = safe;
        plan.ownership.seedAccount = safe;
        DeploymentLib.writeDocument(plan, planPath, true);
        string memory manifestPath = deployer.deployPlanAt(planPath, operator);
        _register(manifestPath);
        configure.configureAt(manifestPath, operator);

        vm.expectRevert(bytes("TestnetSafe: authorized cap below seedAmount for BNB"));
        script.opsAt(manifestPath, 0, plan.assets[0].pool.seedAmount - 1, operator);
    }

    function test_OpsRefusesAManifestWithMoreThanOneSafe() public {
        _fixture("three-roles");
        address safe = _createSafe(5);
        address other = _createSafe(6);
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        plan.name = "three-roles";
        plan.ownership.finalOwner = safe;
        plan.ownership.feeAccount = other;
        plan.ownership.seedAccount = safe;
        DeploymentLib.writeDocument(plan, planPath, true);
        string memory manifestPath = deployer.deployPlanAt(planPath, operator);

        vm.expectRevert(
            bytes(
                "TestnetSafe: this script drives the single-Safe testnet layout only; the manifest names more than one"
            )
        );
        script.opsAt(manifestPath, 0, 0, operator);
    }

    function test_OpsRefusesABroadcasterWhoIsNotTheSafeOwner() public {
        _fixture("wrong-owner");
        address safe = _createSafe(7);
        string memory manifestPath = _deployWithSafe("wrong-owner", safe);
        address stranger = makeAddr("stranger");
        vm.deal(stranger, 1 ether);

        vm.expectRevert(bytes("TestnetSafe: the broadcaster is not the sole Safe owner"));
        script.opsAt(manifestPath, 0, 0, stranger);
    }

    function test_OpsRefusesBeforeConfigureOfferedOwnership() public {
        _fixture("no-configure");
        address safe = _createSafe(8);
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        plan.name = "no-configure";
        plan.ownership.finalOwner = safe;
        plan.ownership.feeAccount = safe;
        plan.ownership.seedAccount = safe;
        DeploymentLib.writeDocument(plan, planPath, true);
        string memory manifestPath = deployer.deployPlanAt(planPath, operator);

        vm.expectRevert(bytes("TestnetSafe: Vault ownership is not pending at the Safe; run Configure first"));
        script.opsAt(manifestPath, 0, 0, operator);
    }

    function test_OpsRefusesAMainnetManifest() public {
        _fixture("mainnet-doc");
        address safe = _createSafe(9);
        string memory manifestPath = _deployWithSafe("mainnet-doc", safe);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        m.environment = "mainnet";
        DeploymentLib.writeDocument(m, manifestPath, false);

        vm.expectRevert(
            bytes(
                "TestnetSafe: mainnet Safes are three distinct 2-of-3 Safes driven from the Safe interface (SPEC 10.5)"
            )
        );
        script.opsAt(manifestPath, 0, 0, operator);
    }

    // ---------------------------------------------------------------------
    // assets: adding a pool to a deployment that is already handed over
    // ---------------------------------------------------------------------

    /// @dev Deploys with the native asset only, hands over, then adds the ERC-20 asset the way an operator adds a
    ///      USDT pool to a live chain 97 deployment. `Configure` cannot do this once the Safe owns the contracts,
    ///      which `test_ConfigureCannotAddAnAssetOnceTheSafeOwnsTheContracts` below pins down.
    function _handOverNativeOnly(string memory tag, address safe) internal returns (string memory manifestPath) {
        DeploymentLib.Manifest memory plan = harness.buildPlan();
        plan.name = tag;
        plan.ownership.finalOwner = safe;
        plan.ownership.feeAccount = safe;
        plan.ownership.seedAccount = safe;
        DeploymentLib.AssetSpec[] memory only = new DeploymentLib.AssetSpec[](1);
        only[0] = plan.assets[0];
        plan.assets = only;
        DeploymentLib.writeDocument(plan, planPath, true);
        manifestPath = deployer.deployPlanAt(planPath, operator);
        _register(manifestPath);
        _labelMocks(manifestPath);
        configure.configureAt(manifestPath, operator);
        script.opsAt(manifestPath, DEPOSIT, 0, operator);
    }

    /// @dev Puts the second asset into the manifest, which is what the operator edits in before the Safe run.
    function _addTokenToManifest(string memory manifestPath) internal returns (DeploymentLib.AssetSpec memory spec) {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        spec = harness.buildPlan().assets[1];
        DeploymentLib.AssetSpec[] memory both = new DeploymentLib.AssetSpec[](2);
        both[0] = m.assets[0];
        both[1] = spec;
        m.assets = both;
        DeploymentLib.writeDocument(m, manifestPath, false);
    }

    function test_AssetsListsOpensAndFundsANewPoolThroughTheSafe() public {
        _fixture("add-asset");
        address safe = _createSafe(10);
        string memory manifestPath = _handOverNativeOnly("add-asset", safe);
        DeploymentLib.AssetSpec memory spec = _addTokenToManifest(manifestPath);

        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        LuckyVault vault = LuckyVault(payable(m.vault.addr));
        LuckyDraw draw = LuckyDraw(m.draw.addr);
        assertEq(draw.poolCount(), 1, "only the native pool before");
        assertFalse(vault.getAsset(spec.asset).listed, "token not listed before");

        uint256 deposit = spec.pool.seedAmount * 4;
        harness.token().mint(safe, deposit);
        script.assetsAt(manifestPath, deposit, operator);

        assertTrue(vault.getAsset(spec.asset).listed, "token listed by the Safe");
        assertEq(uint256(vault.getAsset(spec.asset).tokenDecimals), spec.decimals, "decimals recorded");
        assertEq(draw.poolCount(), 2, "the token pool was opened");
        uint256 poolId = draw.getPool(2).asset == spec.asset ? 2 : 0;
        assertEq(poolId, 2, "the second pool plays the token");
        assertEq(draw.getPool(poolId).seedAmount, spec.pool.seedAmount, "seed amount set");
        assertTrue(draw.getPool(poolId).enabled, "pool enabled");
        assertEq(vault.balanceOf(safe, spec.asset), deposit, "exact token seed balance credited to the Safe");
        assertEq(harness.token().allowance(safe, address(vault)), 0, "the exact-amount approval was fully spent");

        // ops() then authorizes the seed for the new asset, and Configure records what the chain now has.
        script.opsAt(manifestPath, 0, 0, operator);
        assertEq(vault.seedMaxPerRound(safe, spec.asset), spec.pool.seedAmount, "seed authorized for the new asset");

        configure.configureAt(manifestPath, operator);
        DeploymentLib.Manifest memory after_ = DeploymentLib.readDocument(manifestPath);
        assertEq(after_.assets.length, 2, "both assets in the manifest");
        assertEq(after_.assets[1].pool.poolId, poolId, "poolId recorded");
        assertTrue(after_.assets[1].listed, "listed recorded");
        assertEq(
            after_.assets[1].pool.seedAuthorizedMaxPerRound,
            vm.toString(spec.pool.seedAmount),
            "authorized cap recorded"
        );
        for (uint256 k = 0; k < after_.assets[1].pool.firstRoundIds.length; k++) {
            assertGt(after_.assets[1].pool.firstRoundIds[k], 0, "every first round id recorded");
        }
        verifier.seedManifest(manifestPath);
        assertEq(verifier.verifyManifestAt(manifestPath), 0, "Verify passes with the added pool");
    }

    /// @dev The reason this entry point exists: `Configure` is guarded by "the broadcaster is the owner", and after
    ///      the handover the broadcaster is not. Running it against a manifest with an unlisted asset stops at
    ///      `listAsset` rather than half-opening a pool.
    function test_ConfigureCannotAddAnAssetOnceTheSafeOwnsTheContracts() public {
        _fixture("configure-cannot");
        address safe = _createSafe(11);
        string memory manifestPath = _handOverNativeOnly("configure-cannot", safe);
        _addTokenToManifest(manifestPath);

        vm.expectRevert(bytes("Configure: the broadcaster is not the owner and cannot list TEST2"));
        configure.configureAt(manifestPath, operator);
    }

    function test_AssetsIsIdempotentAndDepositsOnlyWhatItIsAsked() public {
        _fixture("add-asset-again");
        address safe = _createSafe(12);
        string memory manifestPath = _handOverNativeOnly("add-asset-again", safe);
        DeploymentLib.AssetSpec memory spec = _addTokenToManifest(manifestPath);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        LuckyVault vault = LuckyVault(payable(m.vault.addr));
        LuckyDraw draw = LuckyDraw(m.draw.addr);

        uint256 deposit = spec.pool.seedAmount * 4;
        harness.token().mint(safe, deposit);
        script.assetsAt(manifestPath, deposit, operator);

        // Second run with no deposit: nothing to list, nothing to open, no token moved.
        script.assetsAt(manifestPath, 0, operator);
        assertEq(draw.poolCount(), 2, "no duplicate pool");
        assertEq(vault.balanceOf(safe, spec.asset), deposit, "no second deposit at TOKEN_DEPOSIT=0");
    }

    function test_AssetsRefusesBeforeTheSafeOwnsTheContracts() public {
        _fixture("not-owned");
        address safe = _createSafe(13);
        string memory manifestPath = _deployWithSafe("not-owned", safe);

        vm.expectRevert(
            bytes(
                "TestnetSafe: the Safe does not own both contracts yet; use Configure until ops() has accepted ownership"
            )
        );
        script.assetsAt(manifestPath, 0, operator);
    }

    function test_AssetsRefusesADepositTheSafeCannotCover() public {
        _fixture("assets-poor");
        address safe = _createSafe(14);
        string memory manifestPath = _handOverNativeOnly("assets-poor", safe);
        DeploymentLib.AssetSpec memory spec = _addTokenToManifest(manifestPath);

        vm.expectRevert(bytes("TestnetSafe: the Safe does not hold enough TEST2 to deposit"));
        script.assetsAt(manifestPath, spec.pool.seedAmount, operator);
    }

    /// @dev L7: `TOKEN_DEPOSIT` is a single raw amount, and raw amounts are not comparable across tokens — the same
    ///      number is 20 USDT at 18 decimals and 2e17 of a 2-decimal token. Rather than depositing it into every
    ///      non-native asset, a manifest that names more than one refuses it and the operator deposits by hand.
    function test_AssetsRefusesTokenDepositWithMoreThanOneNonNativeAsset() public {
        _fixture("two-tokens");
        address safe = _createSafe(18);
        string memory manifestPath = _handOverNativeOnly("two-tokens", safe);
        DeploymentLib.AssetSpec memory spec = _addTokenToManifest(manifestPath);

        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        DeploymentLib.AssetSpec[] memory three = new DeploymentLib.AssetSpec[](3);
        three[0] = m.assets[0];
        three[1] = m.assets[1];
        three[2] = spec;
        three[2].asset = address(0xBEEF);
        three[2].symbol = "TEST3";
        m.assets = three;
        DeploymentLib.writeDocument(m, manifestPath, false);

        vm.expectRevert(
            bytes(
                "TestnetSafe: TOKEN_DEPOSIT is one raw amount but the manifest names more than one non-native asset;"
                " run without it and deposit each token's seed balance by hand (approve then deposit, as the Safe)"
            )
        );
        script.assetsAt(manifestPath, spec.pool.seedAmount, operator);
    }

    function test_AssetsRefusesAMainnetManifest() public {
        _fixture("assets-mainnet");
        address safe = _createSafe(15);
        string memory manifestPath = _handOverNativeOnly("assets-mainnet", safe);
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        m.environment = "mainnet";
        DeploymentLib.writeDocument(m, manifestPath, false);

        vm.expectRevert(
            bytes(
                "TestnetSafe: mainnet Safes are three distinct 2-of-3 Safes driven from the Safe interface (SPEC 10.5)"
            )
        );
        script.assetsAt(manifestPath, 0, operator);
    }
}
