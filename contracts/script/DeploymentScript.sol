// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";

import {DeploymentLib} from "./DeploymentLib.sol";

/// @title DeploymentScript
/// @notice Common base of the deployment scripts: where deployment documents live.
/// @dev The directory is `config/deployments` (SPEC §12) unless `LUCKYDRAW_DEPLOYMENTS_DIR` overrides it. The
///      in-process script tests use the setter rather than the environment variable, because Foundry runs test
///      contracts in parallel inside one process and `vm.setEnv` would let them overwrite each other's paths.
abstract contract DeploymentScript is Script {
    string private _deploymentsDirOverride;

    /// @notice Redirects every document this script reads or writes into `dir`.
    /// @dev Test hook. Operators pass `LUCKYDRAW_DEPLOYMENTS_DIR` instead; a script run from the command line never
    ///      calls this.
    /// @param dir The directory, relative to the Foundry project root, without a trailing slash.
    function setDeploymentsDir(string calldata dir) external {
        _deploymentsDirOverride = dir;
    }

    /// @notice The directory this run reads and writes deployment documents in.
    /// @return dir The directory, relative to the Foundry project root, without a trailing slash.
    function _deploymentsDir() internal view returns (string memory dir) {
        return bytes(_deploymentsDirOverride).length > 0 ? _deploymentsDirOverride : DeploymentLib.deploymentsDir();
    }
}
