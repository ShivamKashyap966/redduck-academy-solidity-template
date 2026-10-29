// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Test-only. Hardhat only emits deployable artifacts for contracts declared in
// the project sources, so we subclass the Chainlink mocks here (forwarding their
// constructors) to get artifacts the tests can deploy by name.
import {VRFCoordinatorV2_5Mock} from "@chainlink/contracts/src/v0.8/vrf/mocks/VRFCoordinatorV2_5Mock.sol";
import {MockV3Aggregator} from "@chainlink/contracts/src/v0.8/shared/mocks/MockV3Aggregator.sol";

contract VRFCoordinatorMock is VRFCoordinatorV2_5Mock {
    constructor(
        uint96 baseFee,
        uint96 gasPrice,
        int256 weiPerUnitLink
    ) VRFCoordinatorV2_5Mock(baseFee, gasPrice, weiPerUnitLink) {}
}

contract PriceFeedMock is MockV3Aggregator {
    constructor(uint8 decimals_, int256 initialAnswer) MockV3Aggregator(decimals_, initialAnswer) {}
}
