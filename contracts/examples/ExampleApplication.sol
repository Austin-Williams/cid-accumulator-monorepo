// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {CIDAccumulator} from "../CIDAccumulator.sol";

/// @notice Minimal example: anyone can record a 32-byte payload in this contract's accumulator.
/// @dev All callers contribute to the same history. A real application decides who may append and when.
contract ExampleApplication is CIDAccumulator {
	function record(bytes32 payload) external {
		_appendLeaf(payload);
	}
}
