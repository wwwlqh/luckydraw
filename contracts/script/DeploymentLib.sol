// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VmSafe} from "forge-std/Vm.sol";

import {IVRFCoordinatorV2_5Views} from "../src/interfaces/IVRFCoordinatorV2_5Views.sol";
import {KIND_COUNT, Kind, PricingConfig, ReferenceKind} from "../src/Types.sol";
import {MockAggregatorV3} from "../test/mocks/MockAggregatorV3.sol";
import {MockVRFCoordinatorV2Plus} from "../test/mocks/MockVRFCoordinatorV2Plus.sol";

/// @title DeploymentLib
/// @notice The shared deployment document: the in-memory shape of a plan/manifest, its JSON reader and writer, and
///         the derived values `Deploy`, `Configure` and `Verify` all agree on (SPEC §12, §15).
/// @dev One document type serves both roles. A *plan* is what the operator writes before a deployment: environment,
///      chain, vrf, ownership and assets, with no deployed facts. A *manifest* is that same document after the
///      scripts filled in addresses, code hashes, blocks, pool identifiers and owners, stored at
///      `config/deployments/<chainId>/<lowercase draw address>.json`. Keeping one struct and one field vocabulary is
///      what makes `Configure` and `Verify` check exactly the fields `Deploy` wrote (SPEC §15 "Validate manifest
///      chain/address agreement").
///
///      The written shape is `config/schema/deployment.schema.json` and `deployment-plan.schema.json`, which are
///      authoritative: both schemas set `additionalProperties: false`, so a field this library invents is a
///      validation error, and the plan schema *forbids* every deployed fact. `node scripts/validate_config.ts`
///      checks the output of these scripts in CI.
///
///      ENCODING RULES (config/README.md "Conventions inside a document"):
///      - addresses are lowercase `0x` hex strings, never checksummed, so string comparison is meaningful;
///      - `bytes32` is a lowercase `0x` hex string;
///      - values that are `uint256` on-chain (subscription id, wei amounts, pool and round ids) are decimal
///        *strings*: they can exceed 2^53 and must never pass through a JSON float;
///      - values bounded by the ABI to 32 bits or less (chainId, decimals, confirmations, callback gas, whole-USD
///        targets, block numbers) are JSON numbers;
///      - an absent optional value is JSON `null`, which reads back as the empty string / zero.
///
///      The document is built as a string and written with `vm.writeJson`, which pretty-prints it in insertion
///      order and fails on malformed JSON. Foundry's `vm.serializeJson` family is deliberately not used: it sorts
///      keys alphabetically and has no representation for `null`.
///
///      The `deploymentId` is `${chainId}:${lowercase Draw address}` everywhere (SPEC §10.3). A colon cannot appear
///      in a Windows file name, so the *file* is named after the Draw address alone while the field keeps the
///      canonical form.
library DeploymentLib {
    /// @dev The forge cheatcode address. Only `VmSafe` members are used: file and JSON access, no chain manipulation.
    VmSafe private constant VM = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Current manifest schema version; bumped whenever a field's meaning changes (SPEC §12).
    uint256 internal constant SCHEMA_VERSION = 1;

    /// @notice Toolchain pins recorded in every manifest; they must match `foundry.toml` (SPEC §12, validator T1).
    string internal constant FOUNDRY_VERSION = "1.8.1";
    string internal constant SOLC_VERSION = "0.8.28";
    string internal constant EVM_VERSION = "paris";
    uint256 internal constant OPTIMIZER_RUNS = 600;
    string internal constant BYTECODE_HASH = "none";

    /// @notice VRF constants SPEC §7.1 fixes for every environment.
    uint256 internal constant NUM_WORDS = 2;

    /// @notice The coordinator getter the deploy script asserts (SPEC §15 "VRF", schema enum).
    string internal constant KEY_HASH_GETTER = "s_provingKeys(bytes32)";

    /// @notice Default location of the deployment documents, relative to the Foundry project root.
    /// @dev Overridable with `LUCKYDRAW_DEPLOYMENTS_DIR` so the script test suite can write into its own scratch
    ///      directory instead of `config/deployments`.
    string internal constant DEFAULT_DEPLOYMENTS_DIR = "../config/deployments";

    // ---------------------------------------------------------------------
    // Document shape (SPEC §15 records, config/schema)
    // ---------------------------------------------------------------------

    /// @notice Provenance of a factual record: where the operator read it and when. Both null means "not verified".
    struct Source {
        string url;
        string date;
    }

    /// @notice The Chain record (SPEC §15). `startBlock` is the block that created the Vault; absent from a plan.
    struct ChainSpec {
        uint256 chainId;
        string name;
        string nativeSymbol;
        string explorerUrl;
        uint256 confirmationDepth;
        uint256 startBlock;
        string rpcEnvPublic;
        string rpcEnvOperational;
    }

    /// @notice The compiler and tool pins the deployed bytecode was produced with (SPEC §12).
    struct Toolchain {
        string foundry;
        string solc;
        string evmVersion;
        bool optimizer;
        uint256 optimizerRuns;
        bool viaIr;
        string bytecodeHash;
    }

    /// @notice How `maxRequestCostNative` was derived (SPEC §7.1, §15 "VRF"); recorded so it can be rechecked.
    struct Derivation {
        uint256 maxGasPriceWei;
        uint256 verificationGasOverhead;
        uint256 premiumPercentage;
        uint256 flatFeeNativeWei;
        string note;
    }

    /// @notice The VRF record (SPEC §15). Every field is constructor-fixed on the Draw except the live flags.
    struct VrfSpec {
        address coordinator;
        bool coordinatorIsMock;
        uint256 subscriptionId;
        address subscriptionOwner;
        bytes32 keyHash;
        uint256 requestConfirmations;
        uint256 numWords;
        uint256 callbackGasLimit;
        uint256 maxRequestCostNative;
        Derivation derivation;
        bool consumerRegistered;
        bytes32 consumerRegistrationTx;
        uint256 lowFundingThresholdNative;
        uint256 measuredCallbackGasUsed;
        Source source;
    }

    /// @notice The Ownership record (SPEC §15). `finalOwner` is the multisig that must accept both transfers.
    struct OwnershipSpec {
        address finalOwner;
        address feeAccount;
        address seedAccount;
        bool ownershipAccepted;
        string makeWholeReserve;
        string makeWholeCap;
        string note;
    }

    /// @notice The Price record (SPEC §15); the six `PricingConfig` fields plus the evidence around them.
    struct PriceSpec {
        address feed;
        bool feedIsMock;
        uint256 feedDecimals;
        string baseQuote;
        uint256 heartbeatSeconds;
        uint256 observedP999IntervalSeconds;
        uint256 maxPriceAge;
        int256 minAnswer;
        int256 maxAnswer;
        bool answerBoundsConfirmedAbsent;
        ReferenceKind referenceKind;
        string displayLabel;
        string pegAssumption;
        string verifiedOn;
        Source source;
    }

    /// @notice The pool `Configure` creates for an asset, and the seven rounds `addPool` opens (SPEC §8.1).
    struct PoolSpec {
        uint256 poolId;
        bool enabled;
        uint256 seedAmount;
        string seedAuthorizedMaxPerRound;
        uint256[KIND_COUNT] targetsUsd;
        uint256[KIND_COUNT] firstRoundIds;
    }

    /// @notice The Asset record (SPEC §15) plus its price feed and its pool.
    struct AssetSpec {
        address asset;
        bool native;
        string symbol;
        string name;
        uint256 decimals;
        bool isMock;
        bool listed;
        bool depositsEnabled;
        string exactTransferEvidence;
        bool requiresZeroReset;
        string status;
        Source source;
        PriceSpec price;
        PoolSpec pool;
    }

    /// @notice One deployed contract's identity and owner state.
    /// @dev `deployTx` is zero (written as `null`) for a script run, which never sees its own transaction hash.
    ///      `pendingOwner` is the zero address when no transfer is pending, never null.
    struct ContractRecord {
        address addr;
        bytes32 codeHash;
        uint256 deployBlock;
        bytes32 deployTx;
        address owner;
        address pendingOwner;
    }

    /// @notice The nine constructor arguments of `LuckyDraw`, recorded so a rebuild can be reproduced byte for byte.
    /// @dev Written as `constructorArgs`: a key named `constructor` collides with `Object.prototype` in JavaScript
    ///      consumers.
    struct DrawConstructor {
        address vault;
        address coordinator;
        uint256 subscriptionId;
        bytes32 keyHash;
        uint256 requestConfirmations;
        uint256 callbackGasLimit;
        uint256 maxRequestCostNative;
        address feeAccount;
        address initialOwner;
    }

    /// @notice A deployment plan or a deployment manifest; the deployed facts are zero in a plan.
    struct Manifest {
        uint256 schemaVersion;
        string name;
        string deploymentId;
        string environment;
        string createdAtUtc;
        string notes;
        ChainSpec chain;
        Toolchain toolchain;
        ContractRecord vault;
        ContractRecord draw;
        DrawConstructor drawConstructor;
        VrfSpec vrf;
        OwnershipSpec ownership;
        AssetSpec[] assets;
        string[] mocks;
        // Schema-supported operator metadata, carried through plans and manifest rewrites without changing
        // its optional presence. Kept apart from facts populated by the deployment scripts.
        string chainExtras;
        string ownershipExtras;
        string[] assetExtras;
        string[] poolExtras;
        // `assets[i].price.observationWindow` (`price.schema.json`): the block range and sample count
        // `observedP999IntervalSeconds` was measured over. Mainnet rule P8 requires it on a filled plan, so a
        // rewrite that dropped it would fail the validator after the gas was already spent.
        string[] priceExtras;
        // The optional top-level `release` object (`customerLaunch`, `shakedown`) is operator evidence written
        // after Finalize; a later Configure or Finalize rewrite must not drop it (SPEC section 14, mainnet MVP).
        string releaseExtras;
    }

    // ---------------------------------------------------------------------
    // Paths
    // ---------------------------------------------------------------------

    /// @notice The deployment document directory, overridable for tests.
    /// @return dir The directory, relative to the Foundry project root, without a trailing slash.
    function deploymentsDir() internal view returns (string memory dir) {
        return VM.envOr("LUCKYDRAW_DEPLOYMENTS_DIR", DEFAULT_DEPLOYMENTS_DIR);
    }

    /// @notice The canonical manifest path for a deployment (SPEC §12, config/README.md naming rules).
    /// @param dir The deployment document directory.
    /// @param chainId The chain the Draw lives on.
    /// @param draw The Draw address; the file is named after it because `deploymentId` contains a colon.
    /// @return path `<dir>/<chainId>/<lowercase draw address>.json`.
    function manifestPath(string memory dir, uint256 chainId, address draw) internal pure returns (string memory path) {
        return string.concat(dir, "/", VM.toString(chainId), "/", lowerHex(draw), ".json");
    }

    /// @notice `${chainId}:${lowercase Draw address}`, the identity every service keys on (SPEC §10.3).
    /// @param chainId The chain id.
    /// @param draw The Draw address.
    /// @return id The deployment identifier.
    function deploymentId(uint256 chainId, address draw) internal pure returns (string memory id) {
        return string.concat(VM.toString(chainId), ":", lowerHex(draw));
    }

    // ---------------------------------------------------------------------
    // Reading
    // ---------------------------------------------------------------------

    /// @notice Reads a plan or a manifest from disk.
    /// @dev Missing optional keys read as zero / empty string, so the same reader serves both documents. A document
    ///      carrying `"template": true` is refused: the shipped example plan is a null-filled template and must never
    ///      be deployed as-is (validator rule TPL).
    /// @param path The file path, relative to the Foundry project root.
    /// @return m The parsed document.
    function readDocument(string memory path) internal view returns (Manifest memory m) {
        require(VM.exists(path), string.concat("DeploymentLib: no such deployment document: ", path));
        string memory json = VM.readFile(path);

        require(
            !_bool(json, ".template", false),
            string.concat("DeploymentLib: refusing a template document (\"template\": true): ", path)
        );

        m.schemaVersion = _uint(json, ".schemaVersion", SCHEMA_VERSION);
        require(
            m.schemaVersion == SCHEMA_VERSION,
            string.concat("DeploymentLib: unsupported schemaVersion ", VM.toString(m.schemaVersion))
        );
        m.name = _str(json, ".name");
        m.deploymentId = _str(json, ".deploymentId");
        m.environment = _requireStr(json, ".environment");
        require(
            _eq(m.environment, "local") || _eq(m.environment, "testnet") || _eq(m.environment, "mainnet"),
            string.concat("DeploymentLib: environment must be local, testnet or mainnet, got ", m.environment)
        );
        m.createdAtUtc = _str(json, ".createdAtUtc");
        m.notes = _str(json, ".notes");

        m.chain = ChainSpec({
            chainId: _requireUint(json, ".chain.chainId"),
            name: _requireStr(json, ".chain.name"),
            nativeSymbol: _str(json, ".chain.nativeSymbol"),
            explorerUrl: _str(json, ".chain.explorerUrl"),
            confirmationDepth: _uint(json, ".chain.confirmationDepth", 0),
            startBlock: _uint(json, ".chain.startBlock", 0),
            rpcEnvPublic: _str(json, ".chain.rpcEnvVars.public"),
            rpcEnvOperational: _str(json, ".chain.rpcEnvVars.operational")
        });

        m.toolchain = Toolchain({
            foundry: _str(json, ".toolchain.foundry"),
            solc: _str(json, ".toolchain.solc"),
            evmVersion: _str(json, ".toolchain.evmVersion"),
            optimizer: _bool(json, ".toolchain.optimizer", false),
            optimizerRuns: _uint(json, ".toolchain.optimizerRuns", 0),
            viaIr: _bool(json, ".toolchain.viaIr", false),
            bytecodeHash: _str(json, ".toolchain.bytecodeHash")
        });

        m.vault = _readContract(json, ".contracts.vault");
        m.draw = _readContract(json, ".contracts.draw");
        m.drawConstructor = DrawConstructor({
            vault: _addr(json, ".contracts.draw.constructorArgs.vault"),
            coordinator: _addr(json, ".contracts.draw.constructorArgs.coordinator"),
            subscriptionId: _uint(json, ".contracts.draw.constructorArgs.subscriptionId", 0),
            keyHash: _b32(json, ".contracts.draw.constructorArgs.keyHash"),
            requestConfirmations: _uint(json, ".contracts.draw.constructorArgs.requestConfirmations", 0),
            callbackGasLimit: _uint(json, ".contracts.draw.constructorArgs.callbackGasLimit", 0),
            maxRequestCostNative: _uint(json, ".contracts.draw.constructorArgs.maxRequestCostNative", 0),
            feeAccount: _addr(json, ".contracts.draw.constructorArgs.feeAccount"),
            initialOwner: _addr(json, ".contracts.draw.constructorArgs.initialOwner")
        });

        m.vrf = VrfSpec({
            coordinator: _requireAddr(json, ".vrf.coordinator"),
            coordinatorIsMock: _bool(json, ".vrf.coordinatorIsMock", false),
            subscriptionId: _requireUint(json, ".vrf.subscriptionId"),
            subscriptionOwner: _addr(json, ".vrf.subscriptionOwner"),
            keyHash: _b32(json, ".vrf.keyHash"),
            requestConfirmations: _requireUint(json, ".vrf.requestConfirmations"),
            numWords: _uint(json, ".vrf.numWords", NUM_WORDS),
            callbackGasLimit: _requireUint(json, ".vrf.callbackGasLimit"),
            maxRequestCostNative: _requireUint(json, ".vrf.maxRequestCostNative"),
            derivation: Derivation({
                maxGasPriceWei: _uint(json, ".vrf.maxRequestCostDerivation.maxGasPriceWei", 0),
                verificationGasOverhead: _uint(json, ".vrf.maxRequestCostDerivation.verificationGasOverhead", 0),
                premiumPercentage: _uint(json, ".vrf.maxRequestCostDerivation.premiumPercentage", 0),
                flatFeeNativeWei: _uint(json, ".vrf.maxRequestCostDerivation.flatFeeNativeWei", 0),
                note: _str(json, ".vrf.maxRequestCostDerivation.note")
            }),
            consumerRegistered: _bool(json, ".vrf.consumerRegistered", false),
            consumerRegistrationTx: _b32(json, ".vrf.consumerRegistrationTx"),
            lowFundingThresholdNative: _requireUint(json, ".vrf.lowFundingThresholdNative"),
            measuredCallbackGasUsed: _uint(json, ".vrf.measuredCallbackGasUsed", 0),
            source: Source({url: _str(json, ".vrf.source.url"), date: _str(json, ".vrf.source.date")})
        });

        m.ownership = OwnershipSpec({
            finalOwner: _requireAddr(json, ".ownership.finalOwner"),
            feeAccount: _requireAddr(json, ".ownership.feeAccount"),
            seedAccount: _requireAddr(json, ".ownership.seedAccount"),
            ownershipAccepted: _bool(json, ".ownership.ownershipAccepted", false),
            makeWholeReserve: _str(json, ".ownership.makeWholeReserve"),
            makeWholeCap: _str(json, ".ownership.makeWholeCap"),
            note: _str(json, ".ownership.note")
        });

        uint256 count;
        while (VM.keyExistsJson(json, string.concat(".assets[", VM.toString(count), "]"))) {
            ++count;
        }
        require(count > 0, string.concat("DeploymentLib: document lists no assets: ", path));
        m.assets = new AssetSpec[](count);
        for (uint256 i = 0; i < count; ++i) {
            m.assets[i] = _readAsset(json, string.concat(".assets[", VM.toString(i), "]"));
        }

        uint256 mockCount;
        while (VM.keyExistsJson(json, string.concat(".mocks[", VM.toString(mockCount), "]"))) {
            ++mockCount;
        }
        m.mocks = new string[](mockCount);
        for (uint256 i = 0; i < mockCount; ++i) {
            m.mocks[i] = _str(json, string.concat(".mocks[", VM.toString(i), "]"));
        }
        _readMetadata(json, m);
        _readPriceExtras(json, m);
        m.releaseExtras = _readRelease(json);
    }

    /// @dev The optional `assets[i].price.observationWindow`: JSON null, or `{fromBlock, toBlock, samples}` copied
    ///      field by field so no operator text is re-emitted unparsed. Its own function called from `readDocument`
    ///      rather than a branch inside `_readMetadata`, whose via-IR stack has no room left for another string.
    function _readPriceExtras(string memory json, Manifest memory m) private view {
        m.priceExtras = new string[](m.assets.length);
        for (uint256 i = 0; i < m.assets.length; ++i) {
            string memory at = string.concat(".assets[", VM.toString(i), "].price.observationWindow");
            if (!VM.keyExistsJson(json, at)) continue;
            m.priceExtras[i] = string.concat(',"observationWindow":', _observationWindowJson(json, at));
        }
    }

    /// @dev One `observationWindow` value: `null` when the record is null, else its three integers.
    function _observationWindowJson(string memory json, string memory at) private view returns (string memory) {
        if (!VM.keyExistsJson(json, string.concat(at, ".fromBlock"))) return "null";
        string memory out = string.concat("{", _metadataField(json, at, "fromBlock", 1));
        out = string.concat(out, _metadataField(json, at, "toBlock", 1));
        out = string.concat(out, _metadataField(json, at, "samples", 1));
        return _removeLeadingComma(string.concat(out, "}"));
    }

    /// @dev These are the optional schema fields not represented by the script's configuration structs.
    ///      Build their JSON with the same escaping and null rules as ordinary fields. No file is reread later,
    ///      so Deploy can carry metadata from a plan into a different manifest path.
    function _readMetadata(string memory json, Manifest memory m) private view {
        m.chainExtras =
            string.concat(_metadataField(json, ".chain", "finalityTag", 0), _metadataField(json, ".chain", "notes", 0));
        if (VM.keyExistsJson(json, ".chain.networkIdentity")) {
            string memory identity =
                string.concat("{", _metadataField(json, ".chain.networkIdentity", "genesisHash", 0));
            identity = string.concat(identity, _metadataField(json, ".chain.networkIdentity", "multicall3", 0));
            identity = string.concat(
                identity,
                ',"source":',
                _sourceJson(
                    Source({
                        url: _str(json, ".chain.networkIdentity.source.url"),
                        date: _str(json, ".chain.networkIdentity.source.date")
                    })
                ),
                "}"
            );
            m.chainExtras = string.concat(m.chainExtras, ',"networkIdentity":', _removeLeadingComma(identity));
        }
        if (VM.keyExistsJson(json, ".ownership.safes")) {
            string memory safes = "[";
            for (uint256 i = 0; VM.keyExistsJson(json, string.concat(".ownership.safes[", VM.toString(i), "]")); ++i) {
                string memory at = string.concat(".ownership.safes[", VM.toString(i), "]");
                string memory item = "{";
                string[5] memory strings = [
                    "role", "implementation", "fallbackHandlerCodeHash", "withdrawalSchedule", "calldataDecodingPolicy"
                ];
                for (uint256 k = 0; k < 5; ++k) {
                    item = string.concat(item, _metadataField(json, at, strings[k], 0));
                }
                item = string.concat(
                    item, _metadataField(json, at, "threshold", 1), _metadataField(json, at, "signerCount", 1)
                );
                string[4] memory flags = ["hardwareKeys", "distinctKeyHolders", "modulesEnabled", "guardEnabled"];
                for (uint256 k = 0; k < 4; ++k) {
                    item = string.concat(item, _metadataField(json, at, flags[k], 2));
                }
                if (VM.keyExistsJson(json, string.concat(at, ".source"))) {
                    item = string.concat(
                        item,
                        ',"source":',
                        _sourceJson(
                            Source({
                                url: _str(json, string.concat(at, ".source.url")),
                                date: _str(json, string.concat(at, ".source.date"))
                            })
                        )
                    );
                }
                safes = string.concat(safes, i == 0 ? "" : ",", _removeLeadingComma(string.concat(item, "}")));
            }
            m.ownershipExtras = string.concat(',"safes":', safes, "]");
        }
        m.assetExtras = new string[](m.assets.length);
        m.poolExtras = new string[](m.assets.length);
        for (uint256 i = 0; i < m.assets.length; ++i) {
            string memory at = string.concat(".assets[", VM.toString(i), "]");
            m.assetExtras[i] = _metadataField(json, at, "notes", 0);
            m.poolExtras[i] = _metadataField(json, string.concat(at, ".pool"), "notes", 0);
            at = string.concat(at, ".issuerReview");
            if (!VM.keyExistsJson(json, at)) continue;
            string memory review = string.concat(
                "{",
                _metadataField(json, at, "upgradeable", 2),
                _metadataField(json, at, "freezeOrBlocklist", 2),
                _metadataField(json, at, "mintAuthority", 0),
                _metadataField(json, at, "rebasing", 2),
                _metadataField(json, at, "reviewedOn", 0)
            );
            review = string.concat(
                review,
                ',"source":',
                _sourceJson(
                    Source({
                        url: _str(json, string.concat(at, ".source.url")),
                        date: _str(json, string.concat(at, ".source.date"))
                    })
                ),
                "}"
            );
            m.assetExtras[i] = string.concat(m.assetExtras[i], ',"issuerReview":', _removeLeadingComma(review));
        }
    }

    /// @dev The manifest's optional `release` object (`deployment.schema.json`): `customerLaunch` and either a
    ///      null `shakedown` or its record. Absent stays absent; nothing here is ever invented by a script.
    /// @return extras The serialized object, or an empty string when the document has no `release` key.
    function _readRelease(string memory json) private view returns (string memory extras) {
        if (!VM.keyExistsJson(json, ".release")) return "";
        _requireReleaseShape(json);
        string memory release = string.concat("{", _metadataField(json, ".release", "customerLaunch", 2));
        if (VM.keyExistsJson(json, ".release.shakedown")) {
            release = string.concat(release, ',"shakedown":', _shakedownJson(json));
        }
        return _removeLeadingComma(string.concat(release, "}"));
    }

    /// @dev Refuses the `release` spellings the schema forbids but `_metadataField` would silently repair.
    ///      `parseJsonBool` and `parseJsonUint` coerce the JSON strings `"true"` and `"123456"` into a boolean and a
    ///      number, so a manifest the validator and the web gate both reject would come back from one Configure run
    ///      as a document they accept. A null `release` and a `shakedown` object missing `performed` are likewise
    ///      rewritten into `{}` and `null` rather than reported, so both are refused here too.
    function _requireReleaseShape(string memory json) private view {
        require(
            VM.keyExistsJson(json, ".release.customerLaunch"),
            "DeploymentLib: release must be an object with customerLaunch, not null"
        );
        require(
            !_isJsonText(json, ".release.customerLaunch"),
            "DeploymentLib: release.customerLaunch must be a JSON boolean, not a string"
        );
        if (VM.keyExistsJson(json, ".release.shakedown")) _requireShakedownShape(json);
    }

    /// @dev `release.shakedown` is null or an object carrying `performed`; its two optional numbers are numbers.
    function _requireShakedownShape(string memory json) private view {
        string memory at = ".release.shakedown";
        if (!VM.keyExistsJson(json, string.concat(at, ".performed"))) {
            require(_isJsonNull(json, at), "DeploymentLib: release.shakedown must be null or an object with performed");
            return;
        }
        require(
            !_isJsonText(json, string.concat(at, ".performed")),
            "DeploymentLib: release.shakedown.performed must be a JSON boolean, not a string"
        );
        require(
            !_isJsonText(json, string.concat(at, ".callbackGasUsed")),
            "DeploymentLib: release.shakedown.callbackGasUsed must be a JSON number, not a string"
        );
        require(
            !_isJsonText(json, string.concat(at, ".requestToFulfilmentSeconds")),
            "DeploymentLib: release.shakedown.requestToFulfilmentSeconds must be a JSON number, not a string"
        );
    }

    /// @dev True when the value at `path` is quoted text. `parseJsonString` cannot tell: it renders a boolean, a
    ///      number and a null as their text too. `vm.parseJson` types the value itself, and a JSON boolean, number
    ///      or null is a single 32-byte word where a string is an offset, a length and its bytes; `parseJsonKeys`
    ///      separates out the objects, which are also longer than one word.
    function _isJsonText(string memory json, string memory path) private view returns (bool) {
        if (!VM.keyExistsJson(json, path)) return false;
        try VM.parseJsonKeys(json, path) returns (string[] memory) {
            return false;
        } catch {}
        try VM.parseJson(json, path) returns (bytes memory raw) {
            return raw.length > 32;
        } catch {
            return false;
        }
    }

    /// @dev True when the value at `path` is JSON null, which Foundry renders as the four-character text "null".
    function _isJsonNull(string memory json, string memory path) private view returns (bool) {
        try VM.parseJsonString(json, path) returns (string memory v) {
            return _eq(v, "null");
        } catch {
            return false;
        }
    }

    /// @dev `release.shakedown`: JSON null when the record is null, else its fields copied one by one.
    function _shakedownJson(string memory json) private view returns (string memory) {
        string memory at = ".release.shakedown";
        if (!VM.keyExistsJson(json, ".release.shakedown.performed")) return "null";
        string memory out = string.concat("{", _metadataField(json, at, "performed", 2));
        out = string.concat(out, _metadataField(json, at, "date", 0));
        out = string.concat(out, ',"roundIds":', _roundIdsJson(json));
        out = string.concat(out, _metadataField(json, at, "callbackGasUsed", 3));
        out = string.concat(out, _metadataField(json, at, "requestToFulfilmentSeconds", 3));
        out = string.concat(out, _metadataField(json, at, "costPerDrawNativeWei", 0));
        return _removeLeadingComma(string.concat(out, "}"));
    }

    /// @dev Integer array copied element by element so no operator text is re-emitted unparsed.
    function _roundIdsJson(string memory json) private view returns (string memory out) {
        uint256[] memory ids = VM.keyExistsJson(json, ".release.shakedown.roundIds")
            ? VM.parseJsonUintArray(json, ".release.shakedown.roundIds")
            : new uint256[](0);
        out = "[";
        for (uint256 i = 0; i < ids.length; ++i) {
            if (i != 0) out = string.concat(out, ",");
            out = string.concat(out, _num(ids[i]));
        }
        out = string.concat(out, "]");
    }

    /// @dev Type 0 is a nullable string, 1 is an integer, 2 is a boolean, 3 is a nullable integer. Absent
    ///      metadata stays absent.
    function _metadataField(string memory json, string memory at, string memory key, uint256 valueType)
        private
        view
        returns (string memory)
    {
        string memory path = string.concat(at, ".", key);
        if (!VM.keyExistsJson(json, path)) return "";
        string memory value;
        if (valueType == 0) value = _metadataString(json, path);
        else if (valueType == 1) value = _num(VM.parseJsonUint(json, path));
        else if (valueType == 2) value = _flag(VM.parseJsonBool(json, path));
        else value = _isNumber(json, path) ? _num(VM.parseJsonUint(json, path)) : "null";
        return string.concat(',"', key, '":', value);
    }

    /// @dev True when the value at `path` parses as an unsigned integer (a JSON null does not).
    function _isNumber(string memory json, string memory path) private view returns (bool) {
        try VM.parseJsonUint(json, path) returns (uint256) {
            return true;
        } catch {
            return false;
        }
    }

    function _metadataString(string memory json, string memory path) private pure returns (string memory) {
        string memory value = VM.parseJsonString(json, path);
        // The existing document convention reserves the literal text "null" for an absent optional value.
        return _eq(value, "null") ? "null" : _quoted(value);
    }

    /// @dev Metadata fields carry a comma for appending to nonempty objects; remove the first for a new object.
    function _removeLeadingComma(string memory obj) private pure returns (string memory) {
        bytes memory raw = bytes(obj);
        if (raw.length < 2 || raw[1] != ",") return obj;
        bytes memory out = new bytes(raw.length - 1);
        out[0] = "{";
        for (uint256 i = 2; i < raw.length; ++i) {
            out[i - 1] = raw[i];
        }
        return string(out);
    }

    /// @dev Reads one `contracts.*` record; every field is optional because a plan has none of them.
    function _readContract(string memory json, string memory at) private view returns (ContractRecord memory r) {
        r.addr = _addr(json, string.concat(at, ".address"));
        r.codeHash = _b32(json, string.concat(at, ".codeHash"));
        r.deployBlock = _uint(json, string.concat(at, ".deployBlock"), 0);
        r.deployTx = _b32(json, string.concat(at, ".deployTx"));
        r.owner = _addr(json, string.concat(at, ".owner"));
        r.pendingOwner = _addr(json, string.concat(at, ".pendingOwner"));
    }

    /// @dev Reads one `assets[i]` record. `listed`, `pool.poolId` and `pool.firstRoundIds` are absent from a plan.
    function _readAsset(string memory json, string memory at) private view returns (AssetSpec memory a) {
        a.asset = _addr(json, string.concat(at, ".asset"));
        a.native = _bool(json, string.concat(at, ".native"), a.asset == address(0));
        require(
            (a.asset == address(0)) == a.native,
            string.concat("DeploymentLib: native flag disagrees with the asset address at ", at)
        );
        a.symbol = _requireStr(json, string.concat(at, ".symbol"));
        a.name = _requireStr(json, string.concat(at, ".name"));
        a.decimals = _requireUint(json, string.concat(at, ".decimals"));
        a.isMock = _bool(json, string.concat(at, ".isMock"), false);
        a.listed = _bool(json, string.concat(at, ".listed"), false);
        a.depositsEnabled = _bool(json, string.concat(at, ".depositsEnabled"), false);
        a.exactTransferEvidence = _str(json, string.concat(at, ".exactTransferEvidence"));
        // SPEC §9.5: optional in the document and false when absent, and it must survive a `Configure` rewrite —
        // the web app reads it to decide whether an ERC-20 entry is offered approve(0) then approve(amount).
        a.requiresZeroReset = _bool(json, string.concat(at, ".requiresZeroReset"), false);
        a.status = _requireStr(json, string.concat(at, ".status"));
        a.source = Source({
            url: _str(json, string.concat(at, ".source.url")), date: _str(json, string.concat(at, ".source.date"))
        });
        a.price = _readPrice(json, string.concat(at, ".price"));

        string memory pool = string.concat(at, ".pool");
        a.pool.poolId = _uint(json, string.concat(pool, ".poolId"), 0);
        a.pool.enabled = _bool(json, string.concat(pool, ".enabled"), true);
        a.pool.seedAmount = _uint(json, string.concat(pool, ".seedAmount"), 0);
        a.pool.seedAuthorizedMaxPerRound = _str(json, string.concat(pool, ".seedAuthorizedMaxPerRound"));
        a.pool.targetsUsd = _readTargets(json, pool);
        a.pool.firstRoundIds = _readFirstRoundIds(json, pool);
    }

    /// @dev Reads the per-`Kind` `targetsUsd` object; every kind key is mandatory (SPEC §15).
    function _readTargets(string memory json, string memory pool)
        private
        view
        returns (uint256[KIND_COUNT] memory targets)
    {
        for (uint256 k = 0; k < KIND_COUNT; ++k) {
            targets[k] = _requireUint(json, string.concat(pool, ".targetsUsd.", kindName(Kind(k))));
        }
    }

    /// @dev Reads the `firstRoundIds` array; absent in a plan, so every entry defaults to zero.
    function _readFirstRoundIds(string memory json, string memory pool)
        private
        view
        returns (uint256[KIND_COUNT] memory ids)
    {
        for (uint256 k = 0; k < KIND_COUNT; ++k) {
            ids[k] = _uint(json, string.concat(pool, ".firstRoundIds[", VM.toString(k), "]"), 0);
        }
    }

    /// @dev Reads one `assets[i].price` record.
    function _readPrice(string memory json, string memory p) private view returns (PriceSpec memory price) {
        price.feed = _requireAddr(json, string.concat(p, ".feed"));
        price.feedIsMock = _bool(json, string.concat(p, ".feedIsMock"), false);
        price.feedDecimals = _requireUint(json, string.concat(p, ".feedDecimals"));
        price.baseQuote = _str(json, string.concat(p, ".baseQuote"));
        price.heartbeatSeconds = _uint(json, string.concat(p, ".heartbeatSeconds"), 0);
        price.observedP999IntervalSeconds = _uint(json, string.concat(p, ".observedP999IntervalSeconds"), 0);
        price.maxPriceAge = _requireUint(json, string.concat(p, ".maxPriceAge"));
        price.minAnswer = _int(json, string.concat(p, ".minAnswer"), 0);
        price.maxAnswer = _int(json, string.concat(p, ".maxAnswer"), 0);
        price.answerBoundsConfirmedAbsent = _bool(json, string.concat(p, ".answerBoundsConfirmedAbsent"), false);
        price.referenceKind = _referenceKind(_requireStr(json, string.concat(p, ".referenceKind")));
        price.displayLabel = _str(json, string.concat(p, ".displayLabel"));
        price.pegAssumption = _str(json, string.concat(p, ".pegAssumption"));
        price.verifiedOn = _str(json, string.concat(p, ".verifiedOn"));
        price.source = Source({
            url: _str(json, string.concat(p, ".source.url")), date: _str(json, string.concat(p, ".source.date"))
        });
    }

    // ---------------------------------------------------------------------
    // Writing
    // ---------------------------------------------------------------------

    /// @notice Writes the manifest to its canonical path, creating the chain directory if needed.
    /// @param m The manifest to write.
    /// @param dir The deployment document directory.
    /// @return path The path written.
    function writeManifest(Manifest memory m, string memory dir) internal returns (string memory path) {
        path = manifestPath(dir, m.chain.chainId, m.draw.addr);
        writeDocument(m, path, false);
    }

    /// @notice Writes a plan or a manifest to an explicit path.
    /// @dev `vm.writeJson` pretty-prints and validates; malformed output fails here rather than in a consumer.
    /// @param m The document.
    /// @param path The destination path, relative to the Foundry project root.
    /// @param asPlan True to emit the plan shape, which must carry no deployed fact.
    function writeDocument(Manifest memory m, string memory path, bool asPlan) internal {
        VM.createDir(_dirname(path), true);
        VM.writeJson(toJson(m, asPlan), path);
        _terminateFile(path);
    }

    /// @dev `vm.writeJson` leaves the file unterminated; every file in this repository is LF-terminated
    ///      (`.gitattributes`, config/README.md, validator warning G3w). Kept out of `writeDocument` so the
    ///      via-IR stack of the serializer stays clear of the file round trip.
    function _terminateFile(string memory path) private {
        string memory written = VM.readFile(path);
        VM.writeFile(path, string.concat(written, "\n"));
    }

    /// @notice Renders the document as compact JSON in the documented key order.
    /// @dev Every object is built by appending one field at a time through `_put`. That keeps exactly one string
    ///      accumulator live per builder: a single long `string.concat` chain per object is easier to read but
    ///      exhausts the via-IR stack once these pure functions are inlined into a large caller.
    /// @param m The document.
    /// @param asPlan True to emit the plan shape (`deployment-plan.schema.json`), false for a manifest.
    /// @return json The JSON text.
    function toJson(Manifest memory m, bool asPlan) internal pure returns (string memory json) {
        string memory out = "{";
        out = _put(out, "schemaVersion", _num(m.schemaVersion));
        if (asPlan) {
            if (bytes(m.name).length > 0) out = _put(out, "name", _quoted(m.name));
            out = _put(out, "environment", _quoted(m.environment));
        } else {
            out = _put(out, "deploymentId", _nullableStr(m.deploymentId));
            out = _put(out, "environment", _quoted(m.environment));
            out = _put(out, "createdAtUtc", _nullableStr(m.createdAtUtc));
        }
        if (bytes(m.notes).length > 0) out = _put(out, "notes", _quoted(m.notes));
        out = _put(out, "chain", _withExtras(_chainJson(m.chain, asPlan), m.chainExtras));
        if (!asPlan) {
            out = _put(out, "toolchain", _toolchainJson(m.toolchain));
            out = _put(out, "contracts", _contractsJson(m));
        }
        out = _put(out, "vrf", _vrfJson(m.vrf, asPlan));
        out = _put(out, "ownership", _withExtras(_ownershipJson(m.ownership, asPlan), m.ownershipExtras));
        out = _put(out, "assets", _assetsJson(m, asPlan));
        if (!asPlan) out = _put(out, "mocks", _mocksJson(m.mocks));
        if (!asPlan && bytes(m.releaseExtras).length > 0) out = _put(out, "release", m.releaseExtras);
        return string.concat(out, "}");
    }

    function _chainJson(ChainSpec memory c, bool asPlan) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "chainId", _num(c.chainId));
        out = _put(out, "name", _quoted(c.name));
        if (bytes(c.nativeSymbol).length > 0) out = _put(out, "nativeSymbol", _quoted(c.nativeSymbol));
        out = _put(out, "explorerUrl", _nullableStr(c.explorerUrl));
        out = _put(out, "confirmationDepth", _num(c.confirmationDepth));
        if (!asPlan) out = _put(out, "startBlock", _num(c.startBlock));
        string memory rpc = "{";
        rpc = _put(rpc, "public", _quoted(c.rpcEnvPublic));
        rpc = _put(rpc, "operational", _quoted(c.rpcEnvOperational));
        out = _put(out, "rpcEnvVars", string.concat(rpc, "}"));
        return string.concat(out, "}");
    }

    function _toolchainJson(Toolchain memory t) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "foundry", _quoted(t.foundry));
        out = _put(out, "solc", _quoted(t.solc));
        out = _put(out, "evmVersion", _quoted(t.evmVersion));
        out = _put(out, "optimizer", _flag(t.optimizer));
        out = _put(out, "optimizerRuns", _num(t.optimizerRuns));
        out = _put(out, "viaIr", _flag(t.viaIr));
        out = _put(out, "bytecodeHash", _quoted(t.bytecodeHash));
        return string.concat(out, "}");
    }

    function _contractsJson(Manifest memory m) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "vault", _contractJson(m.vault, ""));
        out = _put(out, "draw", _contractJson(m.draw, _constructorJson(m.drawConstructor)));
        return string.concat(out, "}");
    }

    function _contractJson(ContractRecord memory r, string memory extra) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "address", _addrJson(r.addr));
        out = _put(out, "codeHash", _b32Json(r.codeHash));
        out = _put(out, "deployBlock", _num(r.deployBlock));
        out = _put(out, "deployTx", _nullableB32(r.deployTx));
        out = _put(out, "owner", _addrJson(r.owner));
        out = _put(out, "pendingOwner", _addrJson(r.pendingOwner));
        if (bytes(extra).length > 0) out = _put(out, "constructorArgs", extra);
        return string.concat(out, "}");
    }

    function _constructorJson(DrawConstructor memory c) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "vault", _addrJson(c.vault));
        out = _put(out, "coordinator", _addrJson(c.coordinator));
        out = _put(out, "subscriptionId", _decimal(c.subscriptionId));
        out = _put(out, "keyHash", _b32Json(c.keyHash));
        out = _put(out, "requestConfirmations", _num(c.requestConfirmations));
        out = _put(out, "callbackGasLimit", _num(c.callbackGasLimit));
        out = _put(out, "maxRequestCostNative", _decimal(c.maxRequestCostNative));
        out = _put(out, "feeAccount", _addrJson(c.feeAccount));
        out = _put(out, "initialOwner", _addrJson(c.initialOwner));
        return string.concat(out, "}");
    }

    function _vrfJson(VrfSpec memory v, bool asPlan) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "coordinator", _addrJson(v.coordinator));
        out = _put(out, "coordinatorIsMock", _flag(v.coordinatorIsMock));
        out = _put(out, "subscriptionId", _decimal(v.subscriptionId));
        if (!asPlan) out = _put(out, "subscriptionOwner", _addrJson(v.subscriptionOwner));
        out = _put(out, "keyHash", _b32Json(v.keyHash));
        out = _put(out, "nativeBilling", "true");
        out = _put(out, "requestConfirmations", _num(v.requestConfirmations));
        out = _put(out, "numWords", _num(v.numWords));
        out = _put(out, "callbackGasLimit", _num(v.callbackGasLimit));
        out = _put(out, "maxRequestCostNative", _decimal(v.maxRequestCostNative));
        out = _put(out, "maxRequestCostDerivation", _derivationJson(v.derivation));
        if (!asPlan) {
            out = _put(out, "consumerRegistered", _flag(v.consumerRegistered));
            out = _put(out, "consumerRegistrationTx", _nullableB32(v.consumerRegistrationTx));
        }
        out = _put(out, "keyHashGetter", _quoted(KEY_HASH_GETTER));
        out = _put(out, "lowFundingThresholdNative", _decimal(v.lowFundingThresholdNative));
        out = _put(out, "measuredCallbackGasUsed", _nullableNum(v.measuredCallbackGasUsed));
        out = _put(out, "source", _sourceJson(v.source));
        return string.concat(out, "}");
    }

    function _derivationJson(Derivation memory d) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "maxGasPriceWei", _decimal(d.maxGasPriceWei));
        out = _put(out, "verificationGasOverhead", _num(d.verificationGasOverhead));
        out = _put(out, "premiumPercentage", _num(d.premiumPercentage));
        out = _put(out, "flatFeeNativeWei", _decimal(d.flatFeeNativeWei));
        out = _put(out, "note", _quoted(d.note));
        return string.concat(out, "}");
    }

    function _ownershipJson(OwnershipSpec memory o, bool asPlan) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "finalOwner", _addrJson(o.finalOwner));
        out = _put(out, "feeAccount", _addrJson(o.feeAccount));
        out = _put(out, "seedAccount", _addrJson(o.seedAccount));
        if (!asPlan) out = _put(out, "ownershipAccepted", _flag(o.ownershipAccepted));
        out = _put(out, "makeWholeReserve", _nullableStr(o.makeWholeReserve));
        out = _put(out, "makeWholeCap", _nullableStr(o.makeWholeCap));
        if (bytes(o.note).length > 0) out = _put(out, "note", _quoted(o.note));
        return string.concat(out, "}");
    }

    function _assetsJson(Manifest memory m, bool asPlan) private pure returns (string memory) {
        string memory out = "[";
        for (uint256 i = 0; i < m.assets.length; ++i) {
            out = string.concat(
                out,
                i == 0 ? "" : ",",
                _withExtras(
                    _assetJson(
                        m.assets[i],
                        asPlan,
                        i < m.poolExtras.length ? m.poolExtras[i] : "",
                        i < m.priceExtras.length ? m.priceExtras[i] : ""
                    ),
                    i < m.assetExtras.length ? m.assetExtras[i] : ""
                )
            );
        }
        return string.concat(out, "]");
    }

    function _mocksJson(string[] memory mocks) private pure returns (string memory) {
        string memory out = "[";
        for (uint256 i = 0; i < mocks.length; ++i) {
            out = string.concat(out, i == 0 ? "" : ",", _quoted(mocks[i]));
        }
        return string.concat(out, "]");
    }

    function _assetJson(AssetSpec memory a, bool asPlan, string memory poolExtras, string memory priceExtras)
        private
        pure
        returns (string memory)
    {
        string memory out = "{";
        out = _put(out, "asset", _addrJson(a.asset));
        out = _put(out, "native", _flag(a.native));
        out = _put(out, "symbol", _quoted(a.symbol));
        out = _put(out, "name", _quoted(a.name));
        out = _put(out, "decimals", _num(a.decimals));
        out = _put(out, "isMock", _flag(a.isMock));
        if (!asPlan) out = _put(out, "listed", _flag(a.listed));
        out = _put(out, "depositsEnabled", _flag(a.depositsEnabled));
        out = _put(out, "exactTransferEvidence", _nullableStr(a.exactTransferEvidence));
        out = _put(out, "requiresZeroReset", _flag(a.requiresZeroReset));
        out = _put(out, "status", _quoted(a.status));
        out = _put(out, "source", _sourceJson(a.source));
        out = _put(out, "price", _withExtras(_priceJson(a.price), priceExtras));
        out = _put(out, "pool", _withExtras(_poolJson(a.pool, asPlan), poolExtras));
        return string.concat(out, "}");
    }

    function _priceJson(PriceSpec memory p) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "feed", _addrJson(p.feed));
        out = _put(out, "feedIsMock", _flag(p.feedIsMock));
        out = _put(out, "feedDecimals", _num(p.feedDecimals));
        out = _put(out, "baseQuote", _quoted(p.baseQuote));
        out = _put(out, "heartbeatSeconds", _nullableNum(p.heartbeatSeconds));
        out = _put(out, "observedP999IntervalSeconds", _nullableNum(p.observedP999IntervalSeconds));
        out = _put(out, "maxPriceAge", _num(p.maxPriceAge));
        out = _put(out, "minAnswer", _unsigned(p.minAnswer));
        out = _put(out, "maxAnswer", _unsigned(p.maxAnswer));
        out = _put(out, "answerBoundsConfirmedAbsent", _flag(p.answerBoundsConfirmedAbsent));
        out = _put(out, "referenceKind", _quoted(referenceKindName(p.referenceKind)));
        out = _put(out, "displayLabel", _nullableStr(p.displayLabel));
        out = _put(out, "pegAssumption", _nullableStr(p.pegAssumption));
        out = _put(out, "verifiedOn", _nullableStr(p.verifiedOn));
        out = _put(out, "source", _sourceJson(p.source));
        return string.concat(out, "}");
    }

    function _poolJson(PoolSpec memory p, bool asPlan) private pure returns (string memory) {
        string memory out = "{";
        if (!asPlan) out = _put(out, "poolId", _decimal(p.poolId));
        out = _put(out, "enabled", _flag(p.enabled));
        out = _put(out, "seedAmount", _decimal(p.seedAmount));
        out = _put(out, "seedAuthorizedMaxPerRound", _nullableStr(p.seedAuthorizedMaxPerRound));
        out = _put(out, "targetsUsd", _targetsJson(p.targetsUsd));
        if (!asPlan) out = _put(out, "firstRoundIds", _idsJson(p.firstRoundIds));
        return string.concat(out, "}");
    }

    function _targetsJson(uint256[KIND_COUNT] memory targets) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "Day100", _num(targets[0]));
        out = _put(out, "Day1k", _num(targets[1]));
        out = _put(out, "Day10k", _num(targets[2]));
        out = _put(out, "Week1k", _num(targets[3]));
        out = _put(out, "Week10k", _num(targets[4]));
        out = _put(out, "Week100k", _num(targets[5]));
        out = _put(out, "Month100k", _num(targets[6]));
        return string.concat(out, "}");
    }

    function _idsJson(uint256[KIND_COUNT] memory ids) private pure returns (string memory) {
        string memory out = "[";
        out = string.concat(out, _decimal(ids[0]), ",");
        out = string.concat(out, _decimal(ids[1]), ",");
        out = string.concat(out, _decimal(ids[2]), ",");
        out = string.concat(out, _decimal(ids[3]), ",");
        out = string.concat(out, _decimal(ids[4]), ",");
        out = string.concat(out, _decimal(ids[5]), ",");
        out = string.concat(out, _decimal(ids[6]), "]");
        return out;
    }

    function _sourceJson(Source memory s) private pure returns (string memory) {
        string memory out = "{";
        out = _put(out, "url", _nullableStr(s.url));
        out = _put(out, "date", _nullableStr(s.date));
        return string.concat(out, "}");
    }

    function _withExtras(string memory obj, string memory extras) private pure returns (string memory) {
        if (bytes(extras).length == 0) return obj;
        bytes memory raw = bytes(obj);
        bytes memory prefix = new bytes(raw.length - 1);
        for (uint256 i = 0; i < prefix.length; ++i) {
            prefix[i] = raw[i];
        }
        return string.concat(string(prefix), extras, "}");
    }

    // ---------------------------------------------------------------------
    // Coordinator views (SPEC §6.2 pre-checks, §15 "VRF")
    // ---------------------------------------------------------------------

    /// @notice Whether the coordinator answers `s_provingKeys(bytes32)` with the expected tuple.
    /// @dev A raw staticcall, because the point is to find out whether the selector exists at all. SPEC §15 makes
    ///      this a deployment gate: without it the Draw's `KeyHashUnsupported` pre-check would revert forever.
    /// @param v The VRF record.
    /// @return exposed True when the call succeeds and returns `(bool,uint64)`.
    /// @return laneRegistered True when the coordinator would fulfil requests on this key hash.
    function exposesProvingKeys(VrfSpec memory v) internal view returns (bool exposed, bool laneRegistered) {
        (bool ok, bytes memory ret) =
            v.coordinator.staticcall(abi.encodeWithSelector(IVRFCoordinatorV2_5Views.s_provingKeys.selector, v.keyHash));
        if (!ok || ret.length < 64) return (false, false);
        (laneRegistered,) = abi.decode(ret, (bool, uint64));
        return (true, laneRegistered);
    }

    /// @notice Whether the coordinator answers `getSubscription(uint256)` with the expected five-value tuple.
    /// @param v The VRF record.
    /// @return exposed True when the call succeeds and decodes.
    function exposesGetSubscription(VrfSpec memory v) internal view returns (bool exposed) {
        (bool ok, bytes memory ret) = v.coordinator
            .staticcall(abi.encodeWithSelector(IVRFCoordinatorV2_5Views.getSubscription.selector, v.subscriptionId));
        return ok && ret.length >= 160;
    }

    /// @notice Whether `consumer` is registered on the subscription (SPEC §7.3, §15 consumer registration receipt).
    /// @param v The VRF record.
    /// @param consumer The address to look for.
    /// @return registered True when the coordinator lists the consumer.
    function isConsumer(VrfSpec memory v, address consumer) internal view returns (bool registered) {
        (,,,, address[] memory consumers) = IVRFCoordinatorV2_5Views(v.coordinator).getSubscription(v.subscriptionId);
        for (uint256 i = 0; i < consumers.length; ++i) {
            if (consumers[i] == consumer) return true;
        }
        return false;
    }

    /// @notice The subscription owner; SPEC §7.3 requires the operator multisig.
    /// @param v The VRF record.
    /// @return owner The subscription owner.
    function subscriptionOwner(VrfSpec memory v) internal view returns (address owner) {
        (,,, owner,) = IVRFCoordinatorV2_5Views(v.coordinator).getSubscription(v.subscriptionId);
    }

    /// @notice The subscription's native balance in wei (SPEC §6.2 funding pre-check).
    /// @param v The VRF record.
    /// @return balance The native balance.
    function subscriptionNativeBalance(VrfSpec memory v) internal view returns (uint256 balance) {
        (, uint96 nativeBalance,,,) = IVRFCoordinatorV2_5Views(v.coordinator).getSubscription(v.subscriptionId);
        return uint256(nativeBalance);
    }

    // ---------------------------------------------------------------------
    // Derived values shared by Deploy, Configure and Verify
    // ---------------------------------------------------------------------

    /// @notice Whether the document references any mock artifact or mock address (SPEC §12, §15, validator M1/D4).
    /// @dev A manifest whose `environment` is not `local` must return false here: "a mainnet manifest may reference
    ///      no mock artifact", and a chain/subscription mismatch is never "silently replaced with mocks".
    ///
    ///      The declared flags (`coordinatorIsMock`, `isMock`, `feedIsMock`, the `mocks` array) are the document's own
    ///      account of itself, so a document built on this repository's mocks with every flag cleared would pass a
    ///      flag-only rule. The addresses are therefore also compared against the deployed code of the mocks
    ///      themselves: `bytecode_hash = "none"` and `cbor_metadata = false` make a mock's runtime code identical for
    ///      every deployment of it, so the comparison is exact and cannot be edited away in the document.
    /// @param m The document.
    /// @return referenced True when any mock flag is set, the `mocks` array is non-empty, or any recorded address
    ///         carries the deployed code of a `test/mocks` artifact.
    function referencesMocks(Manifest memory m) internal view returns (bool referenced) {
        if (m.mocks.length > 0 || m.vrf.coordinatorIsMock) return true;
        if (isRepositoryMock(m.vrf.coordinator)) return true;
        for (uint256 i = 0; i < m.assets.length; ++i) {
            if (m.assets[i].isMock || m.assets[i].price.feedIsMock) return true;
            if (isRepositoryMock(m.assets[i].price.feed)) return true;
            if (isRepositoryMock(m.assets[i].asset)) return true;
        }
        return false;
    }

    /// @notice Whether `addr` carries the deployed code of one of this repository's labeled mocks.
    /// @dev `MockVRFCoordinatorV2Plus` and `MockAggregatorV3` declare no immutable variables, so `runtimeCode` is
    ///      available for them and the code hash is an exact identity. `MockERC20` declares `uint8 immutable
    ///      _decimals`, which makes `type(...).runtimeCode` a compile error, so it is matched against its compiled
    ///      artifact instead, ignoring the bytes the artifact leaves zero for the immutable (see `_isMockErc20`).
    /// @param addr The recorded address; the zero address and accounts without code are never mocks.
    /// @return isMock True when the account's code is one of the mocks.
    function isRepositoryMock(address addr) internal view returns (bool isMock) {
        if (addr == address(0) || addr.code.length == 0) return false;
        bytes32 codeHash = addr.codehash;
        if (codeHash == keccak256(type(MockVRFCoordinatorV2Plus).runtimeCode)) return true;
        if (codeHash == keccak256(type(MockAggregatorV3).runtimeCode)) return true;
        return _isMockErc20(addr);
    }

    /// @dev Compares an account's code with the compiled `MockERC20` artifact. Foundry writes zeros where an
    ///      immutable value is spliced in at construction, so every nonzero artifact byte must match exactly and the
    ///      immutable holes are ignored: that identifies the artifact without depending on the decimals it was
    ///      deployed with.
    function _isMockErc20(address addr) private view returns (bool) {
        bytes memory artifact = VM.getDeployedCode("MockERC20.sol:MockERC20");
        bytes memory deployed = addr.code;
        if (artifact.length == 0 || deployed.length != artifact.length) return false;
        for (uint256 i = 0; i < artifact.length; ++i) {
            if (artifact[i] != 0 && artifact[i] != deployed[i]) return false;
        }
        return true;
    }

    /// @notice The frozen `PricingConfig` an asset's pool is created with (SPEC §3.1).
    /// @param a The asset record.
    /// @return cfg The pricing configuration.
    function pricingOf(AssetSpec memory a) internal pure returns (PricingConfig memory cfg) {
        require(a.price.feedDecimals <= type(uint8).max, "DeploymentLib: feedDecimals out of range");
        require(a.price.maxPriceAge <= type(uint32).max, "DeploymentLib: maxPriceAge out of range");
        return PricingConfig({
            feed: a.price.feed,
            feedDecimals: uint8(a.price.feedDecimals),
            maxPriceAge: uint32(a.price.maxPriceAge),
            referenceKind: a.price.referenceKind,
            minAnswer: a.price.minAnswer,
            maxAnswer: a.price.maxAnswer
        });
    }

    /// @notice The §7.1 worst-case request cost implied by the recorded derivation.
    /// @dev maxGasPrice x (callbackGasLimit + verification overhead) x (1 + premium%) + flat native premium. Returns
    ///      zero when the derivation is not filled in, which callers treat as "nothing to cross-check".
    /// @param v The VRF record.
    /// @return cost The derived worst-case cost in wei.
    function derivedMaxRequestCost(VrfSpec memory v) internal pure returns (uint256 cost) {
        if (v.derivation.maxGasPriceWei == 0 || v.derivation.verificationGasOverhead == 0) return 0;
        uint256 gas = v.callbackGasLimit + v.derivation.verificationGasOverhead;
        cost = v.derivation.maxGasPriceWei * gas;
        cost = cost * (100 + v.derivation.premiumPercentage) / 100;
        cost += v.derivation.flatFeeNativeWei;
    }

    /// @notice The enum name written into the document for a `ReferenceKind`.
    /// @param kind The reference kind.
    /// @return name `"ExactToken"` or `"UnderlyingAsset"`.
    function referenceKindName(ReferenceKind kind) internal pure returns (string memory name) {
        return kind == ReferenceKind.ExactToken ? "ExactToken" : "UnderlyingAsset";
    }

    /// @notice The document label for a schedule kind, used for `targetsUsd` keys and log lines.
    /// @param kind The schedule kind.
    /// @return name `"Day100"`, `"Day1k"`, `"Day10k"`, `"Week1k"`, `"Week10k"`, `"Week100k"` or `"Month100k"`.
    function kindName(Kind kind) internal pure returns (string memory name) {
        if (kind == Kind.Day100) return "Day100";
        if (kind == Kind.Day1k) return "Day1k";
        if (kind == Kind.Day10k) return "Day10k";
        if (kind == Kind.Week1k) return "Week1k";
        if (kind == Kind.Week10k) return "Week10k";
        if (kind == Kind.Week100k) return "Week100k";
        return "Month100k";
    }

    /// @notice `YYYY-MM-DDTHH:MM:SSZ` for a unix timestamp (civil-from-days, Howard Hinnant's algorithm).
    /// @dev Local copy of the calendar conversion so the script never depends on `Schedule`'s cutoff semantics.
    /// @param t The unix timestamp in seconds.
    /// @return stamp The ISO-8601 UTC timestamp.
    function utcTimestamp(uint256 t) internal pure returns (string memory stamp) {
        uint256 z = t / 86400 + 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        uint256 d = doy - (153 * mp + 2) / 5 + 1;
        uint256 m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) ++y;

        uint256 secondOfDay = t % 86400;
        return string.concat(
            VM.toString(y),
            "-",
            _pad2(m),
            "-",
            _pad2(d),
            "T",
            _pad2(secondOfDay / 3600),
            ":",
            _pad2((secondOfDay % 3600) / 60),
            ":",
            _pad2(secondOfDay % 60),
            "Z"
        );
    }

    /// @notice Lowercase `0x` hex for an address; never checksummed, so string comparison is meaningful.
    /// @param a The address.
    /// @return s The lowercase hex string.
    function lowerHex(address a) internal pure returns (string memory s) {
        return _hex(abi.encodePacked(a));
    }

    /// @notice Lowercase `0x` hex for a `bytes32`.
    /// @param b The value.
    /// @return s The lowercase hex string.
    function hex32(bytes32 b) internal pure returns (string memory s) {
        return _hex(abi.encodePacked(b));
    }

    /// @notice Case-sensitive string equality.
    /// @param a Left operand.
    /// @param b Right operand.
    /// @return equal True when the two strings are byte-identical.
    function eq(string memory a, string memory b) internal pure returns (bool equal) {
        return _eq(a, b);
    }

    // ---------------------------------------------------------------------
    // JSON scalars
    // ---------------------------------------------------------------------

    /// @dev Appends `"key":value` to an object under construction, which starts life as the single byte `{`.
    function _put(string memory obj, string memory key, string memory value) private pure returns (string memory) {
        string memory separator = bytes(obj).length == 1 ? "" : ",";
        return string.concat(obj, separator, "\"", key, "\":", value);
    }

    /// @dev A JSON number, or `null` when the value is unset. Zero is the unset marker for every field that uses
    ///      this: a zero heartbeat, a zero observed interval and a zero measured callback are all meaningless.
    function _nullableNum(uint256 v) private pure returns (string memory) {
        return v == 0 ? "null" : VM.toString(v);
    }

    /// @dev A JSON number; only for values the ABI bounds to 32 bits or less, plus block numbers.
    function _num(uint256 v) private pure returns (string memory) {
        return VM.toString(v);
    }

    /// @dev A uint256 as a decimal string; never a JSON number, which would lose precision above 2^53.
    function _decimal(uint256 v) private pure returns (string memory) {
        return _quoted(VM.toString(v));
    }

    /// @dev An aggregator bound as an unsigned decimal string. `PriceReader.validateConfig` rejects negative bounds,
    ///      so a negative value here is a corrupt document rather than a representable state.
    function _unsigned(int256 v) private pure returns (string memory) {
        require(v >= 0, "DeploymentLib: aggregator bounds are unsigned");
        return _quoted(VM.toString(uint256(v)));
    }

    function _flag(bool v) private pure returns (string memory) {
        return v ? "true" : "false";
    }

    function _addrJson(address a) private pure returns (string memory) {
        return _quoted(lowerHex(a));
    }

    function _b32Json(bytes32 b) private pure returns (string memory) {
        return _quoted(hex32(b));
    }

    function _nullableB32(bytes32 b) private pure returns (string memory) {
        return b == bytes32(0) ? "null" : _quoted(hex32(b));
    }

    function _nullableStr(string memory s) private pure returns (string memory) {
        return bytes(s).length == 0 ? "null" : _quoted(s);
    }

    /// @dev Quotes and escapes a string. Control characters are rejected rather than escaped: no field of this
    ///      document may contain them, and silently mangling operator-supplied text would be worse.
    function _quoted(string memory s) private pure returns (string memory) {
        bytes memory raw = bytes(s);
        bytes memory out = new bytes(raw.length * 2);
        uint256 n;
        for (uint256 i = 0; i < raw.length; ++i) {
            bytes1 c = raw[i];
            require(uint8(c) >= 0x20, "DeploymentLib: control character in a document string");
            if (c == '"' || c == "\\") {
                out[n++] = "\\";
            }
            out[n++] = c;
        }
        bytes memory trimmed = new bytes(n);
        for (uint256 i = 0; i < n; ++i) {
            trimmed[i] = out[i];
        }
        return string.concat("\"", string(trimmed), "\"");
    }

    function _hex(bytes memory data) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(2 + data.length * 2);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < data.length; ++i) {
            out[2 + i * 2] = alphabet[uint8(data[i]) >> 4];
            out[3 + i * 2] = alphabet[uint8(data[i]) & 0x0f];
        }
        return string(out);
    }

    function _pad2(uint256 v) private pure returns (string memory) {
        return v < 10 ? string.concat("0", VM.toString(v)) : VM.toString(v);
    }

    function _dirname(string memory path) private pure returns (string memory) {
        bytes memory raw = bytes(path);
        uint256 cut = raw.length;
        for (uint256 i = raw.length; i > 0; --i) {
            if (raw[i - 1] == "/" || raw[i - 1] == "\\") {
                cut = i - 1;
                break;
            }
        }
        require(cut < raw.length, string.concat("DeploymentLib: path has no directory: ", path));
        bytes memory dir = new bytes(cut);
        for (uint256 i = 0; i < cut; ++i) {
            dir[i] = raw[i];
        }
        return string(dir);
    }

    // ---------------------------------------------------------------------
    // JSON readers (absent or null reads as the zero value)
    // ---------------------------------------------------------------------

    /// @dev Foundry renders a JSON `null` as the four-character string "null" rather than reverting, so an absent
    ///      optional value and an explicit null both read back as the empty string. No field of this document may
    ///      legitimately hold the text "null".
    function _str(string memory json, string memory key) private view returns (string memory) {
        if (!VM.keyExistsJson(json, key)) return "";
        try VM.parseJsonString(json, key) returns (string memory v) {
            return _eq(v, "null") ? "" : v;
        } catch {
            return "";
        }
    }

    function _uint(string memory json, string memory key, uint256 dflt) private view returns (uint256) {
        if (!VM.keyExistsJson(json, key)) return dflt;
        try VM.parseJsonUint(json, key) returns (uint256 v) {
            return v;
        } catch {}
        string memory s = _str(json, key);
        if (bytes(s).length == 0) return dflt;
        return VM.parseUint(s);
    }

    function _int(string memory json, string memory key, int256 dflt) private view returns (int256) {
        if (!VM.keyExistsJson(json, key)) return dflt;
        try VM.parseJsonInt(json, key) returns (int256 v) {
            return v;
        } catch {}
        string memory s = _str(json, key);
        if (bytes(s).length == 0) return dflt;
        return VM.parseInt(s);
    }

    function _bool(string memory json, string memory key, bool dflt) private view returns (bool) {
        if (!VM.keyExistsJson(json, key)) return dflt;
        try VM.parseJsonBool(json, key) returns (bool v) {
            return v;
        } catch {
            return dflt;
        }
    }

    function _addr(string memory json, string memory key) private view returns (address) {
        string memory s = _str(json, key);
        if (bytes(s).length == 0) return address(0);
        return VM.parseAddress(s);
    }

    function _b32(string memory json, string memory key) private view returns (bytes32) {
        string memory s = _str(json, key);
        if (bytes(s).length == 0) return bytes32(0);
        return VM.parseBytes32(s);
    }

    function _requireStr(string memory json, string memory key) private view returns (string memory value) {
        value = _str(json, key);
        require(bytes(value).length > 0, _missing(key));
    }

    function _requireUint(string memory json, string memory key) private view returns (uint256 value) {
        require(VM.keyExistsJson(json, key), _missing(key));
        return _uint(json, key, 0);
    }

    function _requireAddr(string memory json, string memory key) private view returns (address value) {
        value = _addr(json, key);
        require(value != address(0), _missing(key));
    }

    function _referenceKind(string memory name) private pure returns (ReferenceKind) {
        if (_eq(name, "ExactToken")) return ReferenceKind.ExactToken;
        if (_eq(name, "UnderlyingAsset")) return ReferenceKind.UnderlyingAsset;
        revert(string.concat("DeploymentLib: referenceKind must be ExactToken or UnderlyingAsset, got ", name));
    }

    /// @dev The caller knows which document it asked for, so the message names the field only. Threading the path
    ///      through every required-field helper keeps one more string alive across the concatenation and pushes the
    ///      via-IR stack over the limit when the reader is inlined into a large caller.
    function _missing(string memory key) private pure returns (string memory) {
        return string.concat("DeploymentLib: missing required field ", key);
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }
}
