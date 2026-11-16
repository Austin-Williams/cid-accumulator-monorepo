// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Storage layout for CIDAccumulatorSingleton to support upgradeable proxies.
library StorageLayoutLib {
	struct Layout {
		uint256 mmrMetaBits;
		bytes32[32] peaks;
	}

	// Unique storage slot for the Layout struct.
	bytes32 internal constant STORAGE_SLOT = keccak256("cid-accumulator.singleton.storage");

	/// @dev Returns the storage pointer to Layout for a given account.
	function layout(address account) internal pure returns (Layout storage l) {
		bytes32 slot = keccak256(abi.encodePacked(account, STORAGE_SLOT));
		assembly {
			l.slot := slot
		}
	}
}
