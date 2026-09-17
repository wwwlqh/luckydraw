// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A labeled stand-in for a 1-of-1 Safe v1.4.1, exposing exactly the surface `TestnetSafe.s.sol` uses.
/// @dev Test fixture only. It reproduces the pre-validated signature rule of `Safe.checkNSignatures` (`v == 1`,
///      `r == owner`, `msg.sender == owner`) and the GS013 revert on a failed inner call with `safeTxGas == 0 &&
///      gasPrice == 0`, so the script's control flow is exercised end to end on anvil. It is not a Safe: it does
///      no ECDSA, no nonce, no guard, no modules, and its byte code has nothing to do with the canonical release.
contract MockSafe {
    address[] private _owners;
    uint256 private _threshold;
    bool private _setUp;

    event ExecutionSuccess(address to, uint256 value, bytes data);

    receive() external payable {}

    function setup(
        address[] calldata owners,
        uint256 threshold,
        address,
        bytes calldata,
        address,
        address,
        uint256,
        address payable
    ) external {
        require(!_setUp, "GS200");
        require(threshold > 0 && threshold <= owners.length, "GS201");
        _owners = owners;
        _threshold = threshold;
        _setUp = true;
    }

    function VERSION() external pure returns (string memory) {
        return "1.4.1";
    }

    function getOwners() external view returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view returns (uint256) {
        return _threshold;
    }

    function getModulesPaginated(address, uint256) external pure returns (address[] memory array, address next) {
        return (new address[](0), address(1));
    }

    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256,
        uint256 gasPrice,
        address,
        address payable,
        bytes memory signatures
    ) external payable returns (bool success) {
        require(operation == 0, "MockSafe: call only");
        require(signatures.length == 65, "GS020");
        bytes32 r;
        uint8 v;
        assembly {
            r := mload(add(signatures, 0x20))
            v := byte(0, mload(add(signatures, 0x60)))
        }
        require(v == 1, "MockSafe: pre-validated signature only");
        address signer = address(uint160(uint256(r)));
        require(_isOwner(signer) && msg.sender == signer, "GS025");
        (success,) = to.call{value: value}(data);
        if (!success && safeTxGas == 0 && gasPrice == 0) revert("GS013");
        emit ExecutionSuccess(to, value, data);
    }

    function _isOwner(address account) private view returns (bool) {
        for (uint256 i = 0; i < _owners.length; i++) {
            if (_owners[i] == account) return true;
        }
        return false;
    }
}

/// @notice A labeled stand-in for the Safe proxy factory: deploys a `MockSafe` and runs its initializer.
/// @dev Test fixture only. The real factory clones the singleton behind a proxy; this one ignores the singleton
///      beyond requiring it to exist, which is all the script checks before the call.
contract MockSafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes calldata initializer, uint256 saltNonce)
        external
        returns (address proxy)
    {
        require(singleton.code.length > 0, "GS002");
        proxy = address(new MockSafe{salt: keccak256(abi.encode(msg.sender, saltNonce))}());
        (bool ok,) = proxy.call(initializer);
        require(ok, "GS013");
    }
}
