// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {Verify} from "../../script/Verify.s.sol";
import {Finalize} from "../../script/Finalize.s.sol";
import {DeploymentLib} from "../../script/DeploymentLib.sol";

/// @dev In-process deployments have no RPC receipts. Supply explicit synthetic RPC responses only in tests.
abstract contract HistoryRpcFixture is Script {
    mapping(bytes32 => string) internal responses;

    function setResponse(string memory method, string memory params, string memory result) public {
        responses[keccak256(abi.encode(method, params))] = result;
    }

    function _mockRpc(string memory method, string memory params) internal view returns (string memory) {
        string memory response = responses[keccak256(abi.encode(method, params))];
        require(bytes(response).length != 0, "Fixture: unexpected RPC request");
        return response;
    }

    function seedManifest(string memory path) public {
        DeploymentLib.Manifest memory m = DeploymentLib.readDocument(path);
        m.vault.deployTx = keccak256(abi.encode(m.vault.addr));
        m.draw.deployTx = keccak256(abi.encode(m.draw.addr));
        _seedReceipt(m.vault);
        _seedReceipt(m.draw);
        // The optional Automation executor (ADR 039) is verified from a creation receipt like the other two.
        if (m.upkeep.addr != address(0)) {
            m.upkeep.deployTx = keccak256(abi.encode(m.upkeep.addr));
            _seedReceipt(
                DeploymentLib.ContractRecord({
                    addr: m.upkeep.addr,
                    codeHash: m.upkeep.codeHash,
                    deployBlock: m.upkeep.deployBlock,
                    deployTx: m.upkeep.deployTx,
                    owner: address(0),
                    pendingOwner: address(0)
                })
            );
        }
        DeploymentLib.writeDocument(m, path, false);
    }

    function _seedReceipt(DeploymentLib.ContractRecord memory r) private {
        string memory number = vm.toString(bytes32(r.deployBlock));
        string memory hash = vm.toString(keccak256(abi.encode(r.deployBlock)));
        setResponse(
            "eth_getTransactionReceipt",
            string.concat('["', vm.toString(r.deployTx), '"]'),
            string.concat(
                '{"transactionHash":"',
                vm.toString(r.deployTx),
                '","contractAddress":"',
                vm.toString(r.addr),
                '","status":"0x1","blockNumber":"',
                number,
                '","blockHash":"',
                hash,
                '"}'
            )
        );
        setResponse(
            "eth_getBlockByNumber",
            string.concat('["', number, '",false]'),
            string.concat('{"number":"', number, '","hash":"', hash, '"}')
        );
    }
}

contract VerifyHarness is Verify, HistoryRpcFixture {
    function _rpcJson(string memory method, string memory params) internal view override returns (string memory) {
        return _mockRpc(method, params);
    }
}

contract FinalizeHarness is Finalize, HistoryRpcFixture {
    function _rpcJson(string memory method, string memory params) internal view override returns (string memory) {
        return _mockRpc(method, params);
    }
}
