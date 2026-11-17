// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {ICIDAccumulator} from "./interfaces/ICIDAccumulator.sol";
import {DagCborDigestLib} from "./libraries/DagCborDigestLib.sol";
import {MetaBitsLib} from "./libraries/MetaBitsLib.sol";
import {MmrLib} from "./libraries/MmrLib.sol";
import {CidLib} from "./libraries/CidLib.sol";
import {StorageLayoutLib} from "./libraries/StorageLayoutLib.sol";

/// @title CIDAccumulator
/// @notice An append-only CID accumulator owned by the inheriting contract.
/// @dev The application controls when to call _appendLeaf and who may trigger it.
abstract contract CIDAccumulator is ICIDAccumulator {
	using MetaBitsLib for uint256;
	using MmrLib for uint256;
	using CidLib for bytes32;

	StorageLayoutLib.Layout private _state;

	/// @inheritdoc ICIDAccumulator
	function getState() external view override returns (uint256, bytes32[32] memory) {
		return (_state.mmrMetaBits, _state.peaks);
	}

	/// @inheritdoc ICIDAccumulator
	function getRootCID() external view override returns (bytes memory) {
		bytes32 root = MmrLib.bagPeaks(_state.mmrMetaBits.getPeakCount(), _state.peaks);
		return root.encodeCid();
	}

	/// @inheritdoc ICIDAccumulator
	function getRootCIDString() external view override returns (string memory) {
		bytes32 root = MmrLib.bagPeaks(_state.mmrMetaBits.getPeakCount(), _state.peaks);
		return root.encodeCidString();
	}

	/// @inheritdoc ICIDAccumulator
	function getMMRMetaBits() external view override returns (uint256) {
		return _state.mmrMetaBits;
	}

	/// @notice Appends one 32-byte payload to this contract's accumulator.
	/// @dev The payload is encoded as a DAG-CBOR byte string before hashing; it is not a leaf digest.
	/// All callers of the application contribute to the same accumulator.
	function _appendLeaf(bytes32 payload) internal {
		uint256 packedBits = _state.mmrMetaBits;
		uint256 currentBlock = block.number;
		bytes32[32] storage peaks = _state.peaks;
		uint256 peakCount = packedBits.getPeakCount();
		uint256 numMerges = packedBits.getLeafCount().mergeCount();
		bytes32[] memory mergeLeftHashes = new bytes32[](numMerges);
		bytes32 carryHash = DagCborDigestLib.encodeRawBytes(payload);

		for (uint256 i; i < numMerges; ) {
			bytes32 topHash = peaks[peakCount - 1];
			peakCount--;
			carryHash = MmrLib.mergeNodes(topHash, carryHash);
			mergeLeftHashes[i] = topHash;
			// prettier-ignore
			unchecked {++i;}
		}
		// Only the resulting peak is written; consumed slots remain available for reuse.
		peaks[peakCount] = carryHash;
		_emitLeafAppended(packedBits, payload, mergeLeftHashes);
		_state.mmrMetaBits = packedBits.updateMetaBits(peakCount, numMerges, currentBlock);
	}

	/// @dev Emits the standard ABI encoding using temporary memory; no buffer escapes.
	function _emitLeafAppended(uint256 packedBits, bytes32 payload, bytes32[] memory mergeLeftHashes) private {
		bytes32 eventTopic = LeafAppended.selector;
		assembly ("memory-safe") {
			let ptr := mload(0x40)
			let hashesLength := shl(5, mload(mergeLeftHashes))
			// Leaf index and previous insertion block are adjacent 32-bit metadata fields.
			mstore(ptr, and(shr(165, packedBits), 0xffffffffffffffff))
			mstore(add(ptr, 32), 64)
			mstore(add(ptr, 64), add(32, hashesLength))
			mstore(add(ptr, 96), payload)
			mcopy(add(ptr, 128), add(mergeLeftHashes, 32), hashesLength)
			// Every body element is a full word, so the encoding needs no trailing padding.
			log1(ptr, add(128, hashesLength), eventTopic)
		}
	}
}
