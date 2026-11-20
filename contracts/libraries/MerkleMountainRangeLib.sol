// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Appends leaves to a Merkle mountain range and computes its root from the peaks.
/// @dev Use the same ordered pair hash for every append and root calculation on a tree.
library MerkleMountainRangeLib {
	/// @notice Appends a leaf digest by merging it with peaks of the same height.
	/// @param peaks The first peakCount entries are the active peaks, ordered from highest to lowest.
	/// @param leafHash Digest of the new leaf.
	/// @param leafCount Number of leaves before the append.
	/// @param peakCount Number of active peaks before the append.
	/// @param hashFunction Computes the parent digest from its left and right child digests.
	/// @return newPeakIndex Index of the resulting peak in the peaks array.
	/// @return mergeLeftHashes Consumed peaks in merge order, starting with the lowest height.
	function appendLeaf(
		bytes32[32] storage peaks,
		bytes32 leafHash,
		uint256 leafCount,
		uint256 peakCount,
		function (bytes32, bytes32) internal pure returns (bytes32) hashFunction
	) internal returns (uint256 newPeakIndex, bytes32[] memory mergeLeftHashes) {
		uint256 numMerges = mergeCount(leafCount);
		mergeLeftHashes = new bytes32[](numMerges);
		newPeakIndex = peakCount;
		bytes32 peakHash = leafHash;

		for (uint256 i; i < numMerges; ++i) {
			--newPeakIndex;
			bytes32 leftHash = peaks[newPeakIndex];
			mergeLeftHashes[i] = leftHash;
			peakHash = hashFunction(leftHash, peakHash);
		}
		// The other consumed slots are outside the active peaks and can be reused.
		peaks[newPeakIndex] = peakHash;
	}

	/// @notice Computes how many merges (carries) will occur for a given leaf index.
	/// @param leafIndex Index of the leaf appended (0-based).
	/// @return count Number of merge steps.
	/// @dev For MMRS the number of merges is equal to the number of trailing ones in the binary representation of the leaf index.
	function mergeCount(uint256 leafIndex) internal pure returns (uint256 count) {
		assembly ("memory-safe") {
			// Incrementing flips the trailing ones to zeros; isolate that run of ones.
			let trailingOnes := and(leafIndex, not(add(leafIndex, 1)))
			// Its bit length is the merge count. CLZ(0) is 256, giving zero for even indices.
			count := sub(256, clz(trailingOnes))
		}
	}

	/// @notice Computes the root hash of the MMR by folding the active peaks from left to right.
	/// @param peakCount Number of peaks.
	/// @param peaks Reference to the contract's storage peaks array.
	/// @param hashFunction The ordered pair hash used to append leaves to this tree.
	/// @param emptyRoot Digest to return when the tree has no leaves.
	/// @return rootHash The root hash of the MMR.
	function bagPeaks(
		uint256 peakCount,
		bytes32[32] storage peaks,
		function (bytes32, bytes32) internal pure returns (bytes32) hashFunction,
		bytes32 emptyRoot
	) internal view returns (bytes32 rootHash) {
		if (peakCount == 0) return emptyRoot;
		rootHash = peaks[0];
		uint256 i = 1;
		while (i < peakCount) {
			rootHash = hashFunction(rootHash, peaks[i]);
			// prettier-ignore
			unchecked {++i;}
		}
	}
}
