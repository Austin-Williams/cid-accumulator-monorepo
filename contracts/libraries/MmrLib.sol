// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DagCborDigestLib} from "./DagCborDigestLib.sol";

/// @notice Library for MMR merge operations: counting carries, merging nodes, and bagging peaks.
library MmrLib {
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
	function bagPeaks(uint256 peakCount, bytes32[32] storage peaks) internal view returns (bytes32 rootHash) {
		if (peakCount == 0) return bytes32(0);
		rootHash = peaks[0];
		uint256 i = 1;
		while (i < peakCount) {
			rootHash = DagCborDigestLib.encodeLinkNode(rootHash, peaks[i]);
			// prettier-ignore
			unchecked {++i;}
		}
	}
}
