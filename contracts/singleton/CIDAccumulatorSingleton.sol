// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DagCborDigestLib} from "../libraries/DagCborDigestLib.sol";
import {MetaBitsLib} from "../libraries/MetaBitsLib.sol";
import {PeaksCacheLib} from "../libraries/PeaksCacheLib.sol";
import {MmrLib} from "../libraries/MmrLib.sol";
import {CidLib} from "../libraries/CidLib.sol";
import {StorageLayoutLib} from "../libraries/StorageLayoutLib.sol";

/// @title CIDAccumulatorSingleton
/// @notice A public goods contract that provides a unique CID accumulator for every msg.sender.
contract CIDAccumulatorSingleton {
	// LIBRARIES
	using DagCborDigestLib for bytes;
	using MetaBitsLib for uint256;
	using PeaksCacheLib for PeaksCacheLib.PeaksCache;
	using MmrLib for uint256;
	using CidLib for bytes32;
	using StorageLayoutLib for address;

	// CUSTOM ERRORS
	error DataBlockTooLargeForIPFS(uint256 actualSize);

	// EVENTS
	event LeafAppended(
		address indexed account,
		uint256 leafIndex,
		uint256 previousInsertBlockNumber,
		bytes payload,
		bytes32[] mergeLeftHashes
	);

	event NewAccountInitialized(address account);

	// CONSTANTS
	// Packed bitfield layout for mmrMetaBits
	uint256 private constant MAX_IPFS_BLOCK_SIZE = 1_000_000; // Just under 1 MB
	uint256 public immutable SINGLETON_BIRTHDAY_BLOCK_NUM;

	constructor() {
		SINGLETON_BIRTHDAY_BLOCK_NUM = block.number;
	}

	// EXTERNAL FUNCTIONS

	/// @notice Returns the packed MMR metadata bits and peaks for any account.
	function getState(address account) external view returns (uint256, bytes32[32] memory) {
		StorageLayoutLib.Layout storage storageLayout = account.layout();
		return (storageLayout.mmrMetaBits, storageLayout.peaks);
	}

	/// @notice Appends a single leaf to the Merkle Mountain Range.
	/// @param payload Raw data block to append.
	function appendLeaf(bytes calldata payload) external {
		StorageLayoutLib.Layout storage storageLayout = msg.sender.layout();
		storageLayout.mmrMetaBits = _appendLeafWithoutCachedPeaks(storageLayout.mmrMetaBits, payload);
	}

	/// @notice Appends leaves from `payloadArr` to the Merkle Mountain Range.
	/// @param payloadArr Array of raw data blocks to append.
	/// @dev This function is gas-optimized for payloadArr.length > 1.
	/// @dev It uses a cache-aside buffer for on-demand peaks loads, which is only more gas efficient for payloadArr.length > 1.
	/// @dev For payloadArr.length == 1, use `appendLeaf` for better gas efficiency.
	function appendLeaves(bytes[] calldata payloadArr) external {
		uint256 payloadArrLen = payloadArr.length;
		if (payloadArrLen == 0) return;

		StorageLayoutLib.Layout storage storageLayout = msg.sender.layout();
		if (payloadArrLen == 1) {
			storageLayout.mmrMetaBits = _appendLeafWithoutCachedPeaks(storageLayout.mmrMetaBits, payloadArr[0]);
			return;
		}

		uint256 packedBits = storageLayout.mmrMetaBits; // SLOAD

		if (packedBits == 0) emit NewAccountInitialized(msg.sender);

		// cache-aside buffer for on-demand peaks loads
		PeaksCacheLib.PeaksCache memory peaksCache;

		for (uint256 i; i < payloadArrLen; ) {
			bytes calldata payload = payloadArr[i];
			packedBits = _appendLeafWithCachedPeaks(packedBits, peaksCache, payload);
			// prettier-ignore
			unchecked {++i;}
		}

		storageLayout.mmrMetaBits = packedBits; // SSTORE
		peaksCache.flush(storageLayout.peaks);
	}

	/// @notice Computes and returns the raw CIDv1 byte sequence for any account’s MMR root.
	function getRootCID(address account) external view returns (bytes memory rawCIDv1) {
		StorageLayoutLib.Layout storage l = account.layout();
		uint256 peakCount = l.mmrMetaBits.getPeakCount();
		bytes32 root = MmrLib.bagPeaks(peakCount, l.peaks);
		rawCIDv1 = root.encodeCid();
	}

	/// @notice Returns the Base32-encoded CID string for any account’s MMR root.
	function getRootCIDString(address account) external view returns (string memory) {
		StorageLayoutLib.Layout storage l = account.layout();
		uint256 peakCount = l.mmrMetaBits.getPeakCount();
		bytes32 root = MmrLib.bagPeaks(peakCount, l.peaks);
		return root.encodeCidString();
	}

	/// @notice Returns the packed MMR metadata bits for any account.
	function getMMRMetaBits(address account) external view returns (uint256) {
		StorageLayoutLib.Layout storage l = account.layout();
		return l.mmrMetaBits;
	}

	// INTERNAL FUNCTIONS

	/// @dev Storage-only path for inserting a single leaf, skips caching peak values for single-leaf gas efficiency.
	/// @param packedBits The packed MMR metadata bits before the insertion.
	/// @param payload The raw data to append.
	/// @return The updated packed MMR metadata bits.
	function _appendLeafWithoutCachedPeaks(uint256 packedBits, bytes calldata payload) internal returns (uint256) {
		if (payload.length > MAX_IPFS_BLOCK_SIZE) revert DataBlockTooLargeForIPFS(payload.length);
		if (packedBits == 0) emit NewAccountInitialized(msg.sender);

		uint256 currentBlock = block.number;
		bytes32[32] storage peaks = msg.sender.layout().peaks;

		uint256 peakCount = packedBits.getPeakCount();
		uint256 numMerges = packedBits.getLeafCount().mergeCount();
		bytes32[] memory mergeLeftHashes = new bytes32[](numMerges);
		bytes32 carryHash = DagCborDigestLib.encodeRawBytes(payload);
		for (uint256 i; i < numMerges; ) {
			bytes32 topHash = peaks[peakCount - 1]; // SLOAD
			peakCount--;
			carryHash = MmrLib.mergeNodes(topHash, carryHash);
			mergeLeftHashes[i] = topHash;
			// prettier-ignore
			unchecked {++i;}
		}
		// write the resulting peak
		peaks[peakCount] = carryHash; // SSTORE

		// Finalize leaf insertion: emit event and update packed bits.
		emit LeafAppended(
			msg.sender,
			packedBits.getLeafCount(),
			packedBits.getPreviousInsertBlockNum(),
			payload,
			mergeLeftHashes
		);
		return packedBits.updateMetaBits(peakCount, numMerges, currentBlock);
	}

	/// @notice Appends a new leaf containing `payload` to the Merkle Mountain Range.
	/// @param payload Raw data to append; must not exceed `MAX_IPFS_BLOCK_SIZE`.
	/// @dev Encodes `payload` via DagCborDigestLib, merges the result with any existing peaks of equal height,
	/// updates packed `mmrMetaBits`, stores the new peak, and emits a `LeafAppended` event with merge details.
	/// This uses a cache-aside buffer for on-demand peaks loads, which is only more gas efficient when inserting multiple leaves in a single call.
	/// For single-leaf gas efficiency, use `_appendLeafWithoutCachedPeaks`.
	function _appendLeafWithCachedPeaks(
		uint256 packedBits,
		PeaksCacheLib.PeaksCache memory peaksCache,
		bytes calldata payload
	) internal returns (uint256) {
		if (payload.length > MAX_IPFS_BLOCK_SIZE) revert DataBlockTooLargeForIPFS(payload.length);

		uint256 currentBlock = block.number;
		bytes32[32] storage peaks = msg.sender.layout().peaks;
		uint256 peakCount = packedBits.getPeakCount();
		uint256 numMerges = packedBits.getLeafCount().mergeCount();

		// Collect the left half of all _mergeNodes steps (required for off-chain integration)
		bytes32[] memory mergeLeftHashes = new bytes32[](numMerges);

		// Merge peaks of equal height
		bytes32 carryHash = DagCborDigestLib.encodeRawBytes(payload);
		for (uint256 i; i < numMerges; ) {
			bytes32 topHash = peaksCache.getPeak(peakCount - 1, peaks); // maybe SLOAD
			peakCount--;
			carryHash = MmrLib.mergeNodes(topHash, carryHash);

			// Record the left input for this merge iteration
			mergeLeftHashes[i] = topHash;
			// prettier-ignore
			unchecked {++i;}
		}

		peaksCache.setPeak(peakCount, carryHash); // Cache the hash of the DAG-CBOR encoded link node

		// Finalize leaf insertion: emit event and update packed bits.
		emit LeafAppended(
			msg.sender,
			packedBits.getLeafCount(),
			packedBits.getPreviousInsertBlockNum(),
			payload, // This is NOT DAG-CBOR encoded
			mergeLeftHashes // These are the hashes of the DAG-CBOR encoded nodes on the left of each _mergeNodes for this merge
		);

		return packedBits.updateMetaBits(peakCount, numMerges, currentBlock);
	}
}
