// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Library for CIDv1 DAG-CBOR multihash encoding.
library CIDLib {
	bytes internal constant ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
	/// @notice Encodes a 32-byte hash as a raw CIDv1 DAG-CBOR multihash.
	/// @param hash The 32-byte hash (digest) to encode.
	/// @return The raw CIDv1 byte sequence: [version][codec][multihash].

	function encodeCid(bytes32 hash) internal pure returns (bytes memory) {
		// Prefix: CIDv1 (0x01), DAG-CBOR (0x71), Keccak-256 (0x1b), digest length 32 (0x20).
		return abi.encodePacked(hex"01711b20", hash);
	}

	/// @notice Encodes a 32-byte hash as a Base32 multibase CID string (prefix 'b').
	/// @dev VERY gas intensive. Only use in code paths that are called from off-chain.
	function encodeCidString(bytes32 hash) internal pure returns (string memory) {
		bytes memory cid = encodeCid(hash);
		return toBase32(cid);
	}

	/// @notice Base32 encodes input data and prepends the 'b' multibase prefix.
	/// @dev VERY gas intensive. Only use in code paths that are called from off-chain.
	function toBase32(bytes memory data) internal pure returns (string memory) {
		bytes memory alphabet = ALPHABET;
		uint256 dataLen = data.length;
		uint256 outLen = (dataLen * 8 + 4) / 5;
		bytes memory result = new bytes(outLen + 1);
		result[0] = "b";
		uint256 buffer;
		uint256 bitsLeft;
		uint256 index = 1;
		for (uint256 i = 0; i < dataLen; i++) {
			buffer = (buffer << 8) | uint8(data[i]);
			bitsLeft += 8;
			while (bitsLeft >= 5) {
				bitsLeft -= 5;
				uint256 code = (buffer >> bitsLeft) & 0x1F;
				result[index++] = alphabet[code];
			}
		}
		if (bitsLeft > 0) {
			uint256 code = (buffer << (5 - bitsLeft)) & 0x1F;
			result[index++] = alphabet[code];
		}
		return string(result);
	}
}
