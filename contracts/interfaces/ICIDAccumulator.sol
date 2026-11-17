// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Read-only interface and append events for an inheriting CID accumulator.
interface ICIDAccumulator {
	/// @dev metadata: low 32 bits = leaf index, high 32 bits = previous insertion block.
	/// @dev payload: the 32-byte payload; mergeHashes: the consumed peaks' 32-byte hashes.
	/// The hash count is the number of trailing one bits in the leaf index.
	event LeafAppended(uint64 metadata, bytes32 payload, bytes mergeHashes);

	/// @notice Returns this accumulator's packed metadata and peaks.
	/// @dev Only the first peakCount entries are active; the rest may contain stale hashes.
	/// peakCount is stored in metadata bits 160..164.
	function getState() external view returns (uint256, bytes32[32] memory);

	/// @notice Returns the raw CIDv1 bytes for this accumulator's root.
	function getRootCID() external view returns (bytes memory);

	/// @notice Returns the Base32-encoded CID string for this accumulator's root.
	function getRootCIDString() external view returns (string memory);

	/// @notice Returns this accumulator's packed metadata, including its first-append birthday.
	function getMMRMetaBits() external view returns (uint256);
}
