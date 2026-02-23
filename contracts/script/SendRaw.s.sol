// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";

contract SendRawScript is Script {
    function run() external {
        address to = vm.envAddress("SEND_TO");
        bytes memory data = vm.envBytes("SEND_DATA");
        uint256 value = vm.envOr("SEND_VALUE", uint256(0));

        vm.startBroadcast();
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        require(ok, string(ret));
        vm.stopBroadcast();
    }
}
