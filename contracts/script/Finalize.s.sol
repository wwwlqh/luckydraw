// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";

import {DeploymentLib} from "./DeploymentLib.sol";
import {DeploymentScript} from "./DeploymentScript.sol";
import {DeploymentHistory} from "./DeploymentHistory.sol";

/// @title Finalize
/// @notice Fills the two facts a script cannot know about itself: the deployment transaction hashes and the blocks
///         they were mined in (SPEC §15 Chain "start block", §10.3 "scanning from verified deployment block").
/// @dev A `forge script` run simulates against the latest block and only then broadcasts, so inside `run()` the
///      creation block does not exist yet: `Deploy` can record no better than the simulation block, which is a lower
///      bound. This script reads Foundry's own broadcast file afterwards -- `broadcast/<script>/<chainId>/run-latest.json`,
///      which pairs each CREATE with its receipt -- and replaces the estimate with the receipt's block number and
///      transaction hash. It writes nothing on chain and needs no key.
///
///      Run it after `DeployLocal` or after `Deploy` + `Configure`, and before `Verify`:
///        LUCKYDRAW_MANIFEST=... LUCKYDRAW_BROADCAST=broadcast/DeployLocal.s.sol/31337/run-latest.json \
///        forge script script/Finalize.s.sol:Finalize
contract Finalize is DeploymentScript, DeploymentHistory {
    /// @notice Updates the manifest named by `LUCKYDRAW_MANIFEST` from the broadcast file `LUCKYDRAW_BROADCAST`.
    /// @return path The manifest path.
    function run() external returns (string memory path) {
        return finalizeAt(vm.envString("LUCKYDRAW_MANIFEST"), vm.envString("LUCKYDRAW_BROADCAST"));
    }

    /// @notice Updates one manifest from one broadcast file.
    /// @param manifestPath The manifest to update in place.
    /// @param broadcastPath Foundry's `run-latest.json` for the run that deployed it.
    /// @return path The manifest path.
    function finalizeAt(string memory manifestPath, string memory broadcastPath) public returns (string memory path) {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(manifestPath);
        require(block.chainid == m.chain.chainId, "Finalize: connected chain differs from manifest");
        require(vm.exists(broadcastPath), string.concat("Finalize: no such broadcast file: ", broadcastPath));
        string memory json = vm.readFile(broadcastPath);
        require(
            vm.parseJsonUint(json, ".chain") == m.chain.chainId,
            "Finalize: the broadcast file is for a different chain than the manifest"
        );

        (bytes32 vaultTx, uint256 fileVaultBlock) = _creation(json, m.vault.addr);
        (bytes32 drawTx, uint256 fileDrawBlock) = _creation(json, m.draw.addr);
        require(vaultTx != bytes32(0), "Finalize: the broadcast file contains no CREATE for the Vault");
        require(drawTx != bytes32(0), "Finalize: the broadcast file contains no CREATE for the Draw");
        // The node is the authority on which block a creation ended up in, not the local broadcast file.
        // `DeploymentHistory` authenticates the receipt itself -- transaction hash, created address, success status,
        // block number and canonical block hash -- so the file only has to name the transaction. A creation that was
        // re-included at a different height after a reorg is then finalized correctly instead of being refused
        // forever with no way to record it (SPEC §15 Chain "start block", §10.3).
        uint256 vaultBlock = _creationBlock(m.vault.addr, vaultTx);
        uint256 drawBlock = _creationBlock(m.draw.addr, drawTx);
        if (vaultBlock != fileVaultBlock) {
            console2.log("Finalize: NOTICE broadcast file says Vault block", fileVaultBlock, "canonical", vaultBlock);
        }
        if (drawBlock != fileDrawBlock) {
            console2.log("Finalize: NOTICE broadcast file says Draw block ", fileDrawBlock, "canonical", drawBlock);
        }

        m.vault.deployTx = vaultTx;
        m.vault.deployBlock = vaultBlock;
        m.draw.deployTx = drawTx;
        m.draw.deployBlock = drawBlock;
        // The indexer scans from here, so it must be at or below both creations (validator rule D17).
        m.chain.startBlock = vaultBlock < drawBlock ? vaultBlock : drawBlock;

        DeploymentLib.writeDocument(m, manifestPath, false);
        console2.log("Finalize: vault block", vaultBlock);
        console2.log("Finalize: draw block ", drawBlock);
        console2.log("Finalize: startBlock ", m.chain.startBlock);
        console2.log("Finalize: manifest", manifestPath);
        return manifestPath;
    }

    /// @notice The receipt of the CREATE that produced `addr`.
    /// @dev Foundry records `contractAddress` on the receipt of a CREATE and `null` on every other receipt, so the
    ///      address alone identifies the creation without parsing the transaction list.
    /// @param json The broadcast file.
    /// @param addr The created contract.
    /// @return txHash The transaction hash, zero when the file holds no such creation.
    /// @return blockNumber The block the creation was mined in.
    function _creation(string memory json, address addr) private view returns (bytes32 txHash, uint256 blockNumber) {
        string memory wanted = DeploymentLib.lowerHex(addr);
        for (uint256 i = 0; vm.keyExistsJson(json, string.concat(".receipts[", vm.toString(i), "]")); ++i) {
            string memory at = string.concat(".receipts[", vm.toString(i), "]");
            string memory created = _string(json, string.concat(at, ".contractAddress"));
            if (bytes(created).length == 0) continue;
            if (!DeploymentLib.eq(vm.toLowercase(created), wanted)) continue;
            txHash = vm.parseBytes32(_string(json, string.concat(at, ".transactionHash")));
            blockNumber = _hexUint(_string(json, string.concat(at, ".blockNumber")));
            return (txHash, blockNumber);
        }
    }

    /// @dev A JSON string field, or the empty string when absent or null.
    function _string(string memory json, string memory key) private view returns (string memory) {
        if (!vm.keyExistsJson(json, key)) return "";
        try vm.parseJsonString(json, key) returns (string memory v) {
            return DeploymentLib.eq(v, "null") ? "" : v;
        } catch {
            return "";
        }
    }

    /// @dev Receipt numbers are `0x`-prefixed hex, which `vm.parseUint` does not accept.
    function _hexUint(string memory value) private pure returns (uint256 result) {
        bytes memory raw = bytes(value);
        require(raw.length > 2 && raw[0] == "0" && (raw[1] == "x" || raw[1] == "X"), "Finalize: not a hex quantity");
        for (uint256 i = 2; i < raw.length; ++i) {
            uint8 c = uint8(raw[i]);
            uint256 digit;
            if (c >= 48 && c <= 57) digit = c - 48;
            else if (c >= 97 && c <= 102) digit = c - 87;
            else if (c >= 65 && c <= 70) digit = c - 55;
            else revert("Finalize: not a hex quantity");
            result = result * 16 + digit;
        }
    }
}
