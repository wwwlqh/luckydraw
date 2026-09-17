// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {DeploymentLib} from "./DeploymentLib.sol";

/// @dev Foundry 1.8.1 supports rpcJson; the pinned forge-std predates its interface declaration.
interface VmRpcJson {
    function rpcJson(string calldata method, string calldata params) external returns (string memory);
}

/// @notice Receipt verification shared by Finalize and Verify. RPC failures and missing history fail closed.
abstract contract DeploymentHistory is Script {
    function _rpcJson(string memory method, string memory params) internal virtual returns (string memory) {
        return VmRpcJson(address(vm)).rpcJson(method, params);
    }

    /// @dev Check a successful top-level creation against its canonical block, not a local broadcast file alone.
    function _creationBlock(address created, bytes32 txHash) internal returns (uint256 number) {
        require(txHash != bytes32(0), "History: missing deployTx; run Finalize first");
        string memory receipt = _rpcJson("eth_getTransactionReceipt", string.concat('["', vm.toString(txHash), '"]'));
        require(!DeploymentLib.eq(receipt, "null"), "History: deployment receipt not found");
        require(vm.parseJsonBytes32(receipt, ".transactionHash") == txHash, "History: transaction hash mismatch");
        require(vm.parseJsonAddress(receipt, ".contractAddress") == created, "History: contract address mismatch");
        require(hexUint(vm.parseJsonString(receipt, ".status")) == 1, "History: deployment transaction failed");
        number = hexUint(vm.parseJsonString(receipt, ".blockNumber"));
        require(number <= block.number, "History: deployment is newer than the verification snapshot");
        bytes32 receiptHash = vm.parseJsonBytes32(receipt, ".blockHash");
        string memory canonical = _rpcJson(
            "eth_getBlockByNumber", string.concat('["', vm.parseJsonString(receipt, ".blockNumber"), '",false]')
        );
        require(!DeploymentLib.eq(canonical, "null"), "History: deployment block not found");
        require(hexUint(vm.parseJsonString(canonical, ".number")) == number, "History: block number mismatch");
        require(vm.parseJsonBytes32(canonical, ".hash") == receiptHash, "History: deployment receipt is not canonical");
    }

    function hexUint(string memory value) internal pure returns (uint256 result) {
        bytes memory raw = bytes(value);
        require(raw.length > 2 && raw[0] == "0" && (raw[1] == "x" || raw[1] == "X"), "History: not a hex quantity");
        for (uint256 i = 2; i < raw.length; ++i) {
            uint8 c = uint8(raw[i]);
            uint256 digit;
            if (c >= 48 && c <= 57) digit = c - 48;
            else if (c >= 97 && c <= 102) digit = c - 87;
            else if (c >= 65 && c <= 70) digit = c - 55;
            else revert("History: not a hex quantity");
            result = result * 16 + digit;
        }
    }
}
