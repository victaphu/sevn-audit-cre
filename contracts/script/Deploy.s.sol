// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../src/AuditAttestation.sol";
import "../src/AuditGate.sol";

contract DeployAll is Script {
    // World ID Router on Sepolia
    address constant WORLD_ID_ROUTER = 0x469449f251692E0779667583026b5A1E99512157;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 appIdHash = vm.envUint("WORLD_APP_ID_HASH");
        uint256 actionIdHash = vm.envUint("WORLD_ACTION_ID_HASH");

        vm.startBroadcast(deployerKey);

        // 1. Deploy AuditAttestation
        AuditAttestation attestation = new AuditAttestation();
        console.log("AuditAttestation:", address(attestation));

        // 2. Deploy AuditGate
        AuditGate gate = new AuditGate(WORLD_ID_ROUTER, appIdHash, actionIdHash);
        console.log("AuditGate:", address(gate));

        vm.stopBroadcast();
    }
}
