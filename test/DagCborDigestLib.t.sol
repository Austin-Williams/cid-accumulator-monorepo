// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {DagCborDigestLib} from "../contracts/libraries/DagCborDigestLib.sol";

contract DagCborDigestLibTest {
	function testCanonicalLengthHeaders() external pure {
		checkHeader(0, hex"40");
		checkHeader(1, hex"41");
		checkHeader(23, hex"57");
		checkHeader(24, hex"5818");
		checkHeader(255, hex"58ff");
		checkHeader(256, hex"590100");
		checkHeader(65_535, hex"59ffff");
		checkHeader(65_536, hex"5a00010000");
	}

	function checkHeader(uint256 length, bytes memory header) private pure {
		bytes memory data = new bytes(length);
		if (length > 0) data[length - 1] = 0xab;
		bytes32 expected = keccak256(bytes.concat(header, data));
		assert(DagCborDigestLib.encodeRawBytes(data) == expected);
		assert(data.length == length);
	}

	function testBytes32OverloadParity() external pure {
		bytes32 word = bytes32(uint256(0x123400));
		assert(DagCborDigestLib.encodeRawBytes(abi.encodePacked(word)) == DagCborDigestLib.encodeRawBytes(word));
	}

	function testMaximumPayload() external pure {
		// Client DAG-CBOR/Keccak digest of 2,097,147 zero bytes.
		bytes32 digest = DagCborDigestLib.encodeRawBytes(new bytes(2_097_147));
		assert(digest == hex"6ae72085637abadf51dd68039262c50a0cddc0b5525f31b5e8ffc9cf51fefc71");
	}

	function testOversizedPayloadReverts() external view {
		uint256 length = 2_097_148;
		try this.hashZeroBytes(length) returns (bytes32) {
			revert("oversized payload accepted");
		} catch (bytes memory reason) {
			bytes memory expected = abi.encodeWithSelector(DagCborDigestLib.PayloadTooLarge.selector, length);
			assert(keccak256(reason) == keccak256(expected));
		}
	}

	function hashZeroBytes(uint256 length) external pure returns (bytes32) {
		return DagCborDigestLib.encodeRawBytes(new bytes(length));
	}
}
