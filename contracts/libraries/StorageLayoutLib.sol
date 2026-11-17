// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice State stored privately by each inheriting CIDAccumulator contract.
library StorageLayoutLib {
	struct Layout {
		uint256 mmrMetaBits;
		bytes32[32] peaks;
	}
}
