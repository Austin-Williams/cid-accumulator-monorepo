// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/// @notice Library for caching and flushing MMR peaks to storage.
library PeaksCacheLib {
	struct PeaksCache {
		bytes32[32] peakValues;
		uint256 dirtyMask;
	}

	/// @notice Retrieves a peak value, caching it from storage if necessary.
	/// @param cache In-memory peaks cache.
	/// @param i Index of the peak to retrieve.
	/// @param store Reference to the contract's storage peaks array.
	/// @return peak The peak hash at index `i`.
	function getPeak(
		PeaksCache memory cache,
		uint256 i,
		bytes32[32] storage store
	) internal view returns (bytes32 peak) {
		// load or cache the peak in one go
		if ((peak = cache.peakValues[i]) == bytes32(0)) {
			cache.peakValues[i] = peak = store[i];
			cache.dirtyMask |= 1 << i;
		}
	}

	/// @notice Caches a new peak value, marking its slot dirty.
	/// @param cache In-memory peaks cache.
	/// @param i Index at which to set the new peak.
	/// @param val The new peak hash.
	function setPeak(PeaksCache memory cache, uint256 i, bytes32 val) internal pure {
		cache.peakValues[i] = val;
		cache.dirtyMask |= (1 << i);
	}

	/// @notice Flushes all dirty cached peaks to contract storage.
	/// @param cache In-memory peaks cache.
	/// @param store Reference to the contract's storage peaks array.
	function flush(PeaksCache memory cache, bytes32[32] storage store) internal {
		uint256 mask = cache.dirtyMask;
		if (mask == 0) return;
		// iterate with unchecked increments
		for (uint256 i = 0; i < 32; ) {
			if (((mask >> i) & 1) == 1) store[i] = cache.peakValues[i];
			// prettier-ignore
			unchecked {++i;}
		}
	}
}
