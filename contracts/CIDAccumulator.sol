// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICIDAccumulator} from "./interfaces/ICIDAccumulator.sol";
import {DagCborDigestLib} from "./libraries/DagCborDigestLib.sol";
import {MetaBitsLib} from "./libraries/MetaBitsLib.sol";
import {MerkleMountainRangeLib} from "./libraries/MerkleMountainRangeLib.sol";
import {CIDLib} from "./libraries/CIDLib.sol";

/// @title CIDAccumulator
/// @notice An append-only CID accumulator.
abstract contract CIDAccumulator is ICIDAccumulator {
	using MetaBitsLib for uint256;
	using CIDLib for bytes32;

	/// @dev As per IPFS convention, the empty accumulator's root is the digest of DAG-CBOR null (0xf6).
	bytes32 private constant EMPTY_ROOT_DIGEST = keccak256(hex"f6");

	/// @custom:storage-location erc7201:cid-accumulator.storage.CIDAccumulator
	/// @dev Keep the namespace and existing field order/types unchanged across upgrades.
	struct CIDAccumulatorStorage {
		uint256 merkleMountainRangeMetaBits;
		bytes32[32] peaks;
	}

	function _getAccumulatorStorage() private pure returns (CIDAccumulatorStorage storage state) {
		uint256 slot = erc7201("cid-accumulator.storage.CIDAccumulator");
		assembly ("memory-safe") {
			state.slot := slot
		}
	}

	/// @inheritdoc ICIDAccumulator
	function getCIDAccumulatorState() external view returns (uint256, bytes32[32] memory) {
		CIDAccumulatorStorage storage state = _getAccumulatorStorage();
		return (state.merkleMountainRangeMetaBits, state.peaks);
	}

	/// @inheritdoc ICIDAccumulator
	function getCIDAccumulatorRootCIDString() external view returns (string memory) {
		CIDAccumulatorStorage storage state = _getAccumulatorStorage();
		bytes32 root = MerkleMountainRangeLib.bagPeaks({
			peakCount: state.merkleMountainRangeMetaBits.getPeakCount(),
			peaks: state.peaks,
			hashFunction: DagCborDigestLib.encodeLinkNode,
			emptyRoot: EMPTY_ROOT_DIGEST
		});
		return root.encodeCidString();
	}

	/// @notice Appends one 32-byte payload to this contract's accumulator.
	/// @dev This function encodes the payload as a DAG-CBOR byte string before hashing; it is not a leaf digest.
	function _appendDataToCIDAccumulator(bytes32 payload) internal {
		CIDAccumulatorStorage storage state = _getAccumulatorStorage();
		uint256 previousMetaBits = state.merkleMountainRangeMetaBits;
		bytes32 leafHash = DagCborDigestLib.encodeRawBytes(payload);
		(uint256 newPeakIndex, bytes32[] memory mergeLeftHashes) = MerkleMountainRangeLib.appendLeaf({
			peaks: state.peaks,
			leafHash: leafHash,
			leafCount: previousMetaBits.getLeafCount(),
			peakCount: previousMetaBits.getPeakCount(),
			hashFunction: DagCborDigestLib.encodeLinkNode
		});

		_emitDataAppended(previousMetaBits, payload, mergeLeftHashes);
		state.merkleMountainRangeMetaBits = previousMetaBits.updateMetaBits(
			newPeakIndex,
			mergeLeftHashes.length,
			block.number
		);
	}

	/// @dev Emits the DataAppended event.
	function _emitDataAppended(uint256 packedBits, bytes32 payload, bytes32[] memory mergeLeftHashes) private {
		bytes32 eventTopic = DataAppendedToCIDAccumulator.selector;
		assembly ("memory-safe") {
			let ptr := mload(0x40)
			let hashesLength := shl(5, mload(mergeLeftHashes))
			// Leaf index and previous insertion block are adjacent 32-bit metadata fields.
			mstore(ptr, and(shr(165, packedBits), 0xffffffffffffffff))
			mstore(add(ptr, 32), payload)
			mstore(add(ptr, 64), 96)
			mstore(add(ptr, 96), hashesLength)
			mcopy(add(ptr, 128), add(mergeLeftHashes, 32), hashesLength)
			// Every body element is a full word, so the encoding needs no trailing padding.
			log1(ptr, add(128, hashesLength), eventTopic)
		}
	}
}
