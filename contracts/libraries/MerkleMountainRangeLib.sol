// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DagCborDigestLib} from "./DagCborDigestLib.sol";

/// @notice Appends leaves to a Merkle mountain range and computes its root from the peaks.
library MerkleMountainRangeLib {
	/// @notice Appends a leaf digest by merging it with peaks of the same height.
	/// @param peaks The first peakCount entries are the active peaks, ordered from highest to lowest.
	/// @param leafHash DAG-CBOR digest of the new leaf.
	/// @param leafCount Number of leaves before the append.
	/// @param peakCount Number of active peaks before the append.
	/// @return newPeakIndex Index of the resulting peak in the peaks array.
	/// @return mergeLeftHashes Consumed peaks in merge order, starting with the lowest height.
	function appendLeaf(
		bytes32[32] storage peaks,
		bytes32 leafHash,
		uint256 leafCount,
		uint256 peakCount
	) internal returns (uint256 newPeakIndex, bytes32[] memory mergeLeftHashes) {
		uint256 numMerges = mergeCount(leafCount);
		mergeLeftHashes = new bytes32[](numMerges);
		newPeakIndex = peakCount;
		bytes32 peakHash = leafHash;

		for (uint256 i; i < numMerges; ++i) {
			--newPeakIndex;
			bytes32 leftHash = peaks[newPeakIndex];
			mergeLeftHashes[i] = leftHash;
			peakHash = mergeNodes(leftHash, peakHash);
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

	/// @notice Merges two nodes (hashes) into a single node (hash) by encoding them as a DAG-CBOR link node.
	/// @param left The hash of the left node.
	/// @param right The hash of the right node.
	/// @return mergedHash The hash of the merged node.
	function mergeNodes(bytes32 left, bytes32 right) internal pure returns (bytes32 mergedHash) {
		mergedHash = DagCborDigestLib.encodeLinkNode(left, right);
	}

	/// @notice Computes the root hash of the MMR by bagging all peaks.
	/// @param peakCount Number of peaks.
	/// @param peaks Reference to the contract's storage peaks array.
	/// @return rootHash The root hash of the MMR.
	/// @dev The empty root is the digest of DAG-CBOR null (0xf6).
	function bagPeaks(uint256 peakCount, bytes32[32] storage peaks) internal view returns (bytes32 rootHash) {
		if (peakCount == 0) return keccak256(hex"f6");
		rootHash = peaks[0];
		uint256 i = 1;
		while (i < peakCount) {
			rootHash = DagCborDigestLib.encodeLinkNode(rootHash, peaks[i]);
			// prettier-ignore
			unchecked {++i;}
		}
	}
}
