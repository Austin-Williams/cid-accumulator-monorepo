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
		bytes32 namespace = STORAGE_SLOT;
		assembly ("memory-safe") {
			// Pack the 20-byte address and 32-byte namespace into scratch memory.
			mstore(0, shl(96, account))
			mstore(20, namespace)
			l.slot := keccak256(0, 52)
		}
	}
}
