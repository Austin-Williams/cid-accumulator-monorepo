// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

// High-level overview of the CID encoding process:
//
// A Content Identifier (CID) in IPFS/IPLD is a self-describing reference to data. A CIDv1 wraps a version, codec, and multihash.
// To create a CID from raw data, we CBOR-encode the data and compute its Keccak-256 hash (that is what the `encodeRawBytes` function does).
// This hash is the "multihash digest" that becomes the CID's body.
// Later, to get the full CID, we prepend the multihash body with the CID version code (0x01 for CIDv1), codec code (0x71 for dag-cbor), and
// multihash prefix (0x1b for keccak-256, 0x20 for length 32 bytes) before the digest.
//
// IPLD Link nodes represent pointers between DAG blocks. They are CBOR maps with "L" and "R" keys mapping to link values:
// each link is prefixed with tag 42 and a 37-byte byte-string containing the CID multihash. The `encodeLinkNode` function
// builds this CBOR map in memory, hashes the result, and returns the new multihash digest for the link node.

/// @title DagCborDigestLib
/// @notice Provides CBOR byte-string encoding and CID link-node construction for IPFS/IPLD.
/// @dev Implements RFC 7049 §2.1 for byte strings and builds DAG-CBOR link nodes per Multiformats (CIDv1/Multihash).
library DagCborDigestLib {
	/// @notice Encodes a 32-byte payload as a CBOR byte string and returns its Keccak-256 digest.
	/// @param data The complete 32-byte payload, including any leading or trailing zeros.
	/// @return hash The Keccak-256 digest of the CBOR-encoded payload.
	/// @dev A 32-byte CBOR byte string has the two-byte header 0x5820.
	/// @dev See also: [RFC 7049 §2.1](https://datatracker.ietf.org/doc/html/rfc7049#section-2.1)
	function encodeRawBytes(bytes32 data) internal pure returns (bytes32 hash) {
		assembly ("memory-safe") {
			// Use the two scratch words: header at bytes 30..31, payload at bytes 32..63.
			mstore(0, 0x5820)
			mstore(32, data)
			hash := keccak256(30, 34)
		}
	}
	/// @notice Encodes two child CIDs into a CBOR map and returns its Keccak-256 digest.
	/// @param leftHash Body of the left child CID’s multihash (Keccak-256 digest of its CBOR block).
	/// @param rightHash Body of the right child CID’s multihash.
	/// @return hash Keccak-256 digest of the CBOR-encoded link node (multihash body).
	/// @dev Constructs CBOR map(2): { "L": link(leftHash), "R": link(rightHash) }.
	/// @dev Each link(x) = CBOR tag(42) + byte-string[37]:
	/// @dev [0x00 identity multibase, 0x01 CIDv1, 0x71 dag-cbor codec, 0x1b keccak-256, 0x20 (32), x]
	/// @dev See also: [IPLD dag-cbor spec](https://ipld.io/specs/codecs/dag-cbor/spec/) for the CBOR map layout.
	/// @dev See also: [Multiformats multicodec table](https://github.com/multiformats/multicodec/blob/master/table.csv) for dag-cbor prefix.
	/// @dev See also: [Multiformats multihash spec](https://github.com/multiformats/multihash?tab=readme-ov-file#format) for multihash format.
	/// @dev See also: [Multiformats CID spec](https://github.com/multiformats/cid?tab=readme-ov-file#cidv1) for CIDv1 format.

	function encodeLinkNode(bytes32 leftHash, bytes32 rightHash) internal pure returns (bytes32 hash) {
		// Start inline assembly for CBOR link node construction and Keccak-256 hashing
		assembly ("memory-safe") {
			// Reuse memory at the free pointer without advancing it; only the digest escapes.
			let ptr := mload(0x40)
			// Bytes 0..11: map(2), "L", tag(42), bytes(37), identity prefix, CIDv1/DAG-CBOR/Keccak-256.
			// Left-align the 12-byte header; the digest write replaces the word's trailing zeros.
			mstore(ptr, shl(160, 0xa2614cd82a58250001711b20))
			// Bytes 12..43: left digest.
			mstore(add(ptr, 12), leftHash)
			// Bytes 44..54: "R" and the same link header, without the map prefix.
			// Left-align the 11-byte header before writing the right digest.
			mstore(add(ptr, 44), shl(168, 0x6152d82a58250001711b20))
			// Bytes 55..86: right digest.
			mstore(add(ptr, 55), rightHash)
			// Compute the Keccak-256 digest of the encoded link node
			hash := keccak256(ptr, 87)
		}
	}
}
