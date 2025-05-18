// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

/**
 * Layout (from least significant bit to most):
 * Bits 0–159   : 32 peak node heights (5 bits each). heights[i] = (bits >> (i * 5)) & 0x1F
 * Bits 160–164 : peakCount (5 bits) — number of peaks currently in use
 * Bits 165–196 : leafCount (32 bits) — total number of data leaves added
 * Bits 197–228 : previousInsertBlockNumber (32 bits)
 * Bits 229–255 : deployBlockNumber (27 bits) — block number this contract was deployed in
 *
 * This structure allows us to avoid separate storage slots for peak metadata,
 * reducing gas usage by packing everything into a single uint256.
 */

/// @notice Library for packed MMR metadata bit manipulations.
library MetaBitsLib {
	uint256 internal constant PEAK_COUNT_OFFSET = 160;
	uint256 internal constant PEAK_COUNT_MASK = 0x1F;
	uint256 internal constant LEAF_COUNT_OFFSET = 165;
	uint256 internal constant LEAF_COUNT_MASK = 0xFFFFFFFF;
	uint256 internal constant PREVIOUS_INSERT_BLOCKNUM_OFFSET = 197;
	uint256 internal constant PREVIOUS_INSERT_BLOCKNUM_MASK = 0xFFFFFFFF;
	uint256 internal constant DEPLOY_BLOCKNUM_OFFSET = 229;
	uint256 internal constant DEPLOY_BLOCKNUM_MASK = 0x7FFFFFF;

	// combined masks for peakCount & leafCount fields
	uint256 internal constant COUNTS_MASK =
		(PEAK_COUNT_MASK << PEAK_COUNT_OFFSET) | (LEAF_COUNT_MASK << LEAF_COUNT_OFFSET);

	// mask for previousInsertBlockNumber field
	uint256 internal constant PREV_BLOCK_MASK = PREVIOUS_INSERT_BLOCKNUM_MASK << PREVIOUS_INSERT_BLOCKNUM_OFFSET;

	/// @notice Extracts the number of peaks from packed bits.
	function getPeakCount(uint256 bits) internal pure returns (uint256) {
		return (bits >> PEAK_COUNT_OFFSET) & PEAK_COUNT_MASK;
	}

	/// @notice Extracts the total leaf count from packed bits.
	function getLeafCount(uint256 bits) internal pure returns (uint256) {
		return (bits >> LEAF_COUNT_OFFSET) & LEAF_COUNT_MASK;
	}

	/// @notice Extracts the previous insert block number from packed bits.
	function getPreviousInsertBlockNum(uint256 bits) internal pure returns (uint256) {
		return (bits >> PREVIOUS_INSERT_BLOCKNUM_OFFSET) & PREVIOUS_INSERT_BLOCKNUM_MASK;
	}

	/// @notice Extracts the deployment block number from packed bits.
	function getDeployBlockNum(uint256 bits) internal pure returns (uint256) {
		return (bits >> DEPLOY_BLOCKNUM_OFFSET) & DEPLOY_BLOCKNUM_MASK;
	}

	/// @notice Extracts the height of the peak at index i.
	function getPeakHeight(uint256 bits, uint256 index) internal pure returns (uint256) {
		// optimize index*5 as (index<<2)+index
		uint256 shift = (index << 2) + index;
		return (bits >> shift) & PEAK_COUNT_MASK;
	}

	/// @notice Update metadata bits after a leaf insertion.
	/// @param packedBits Original packed metadata.
	/// @param peakCount Index of carry height.
	/// @param carryHeight Height of the new carry.
	/// @param currentBlock Block number at insertion time.
	function updateMetaBits(
		uint256 packedBits,
		uint256 peakCount,
		uint256 carryHeight,
		uint256 currentBlock
	) internal pure returns (uint256) {
		// lazy init deployBlockNumber on first append
		if (getDeployBlockNum(packedBits) == 0) packedBits = setDeployBlockNum(packedBits, currentBlock);

		// extract the previous leaf count
		uint256 leafCount = (packedBits >> LEAF_COUNT_OFFSET) & LEAF_COUNT_MASK;

		// clear + set carry height at peakCount*5
		uint256 heightShift = (peakCount << 2) + peakCount;
		uint256 heightMask = PEAK_COUNT_MASK << heightShift;
		packedBits = (packedBits & ~heightMask) | (carryHeight << heightShift);

		// clear and bump peakCount & leafCount
		packedBits &= ~COUNTS_MASK;
		unchecked {
			packedBits |= ((peakCount + 1) << PEAK_COUNT_OFFSET) | ((leafCount + 1) << LEAF_COUNT_OFFSET);
		}

		// clear and set previousInsertBlockNumber
		packedBits = (packedBits & ~PREV_BLOCK_MASK) | (currentBlock << PREVIOUS_INSERT_BLOCKNUM_OFFSET);
		return packedBits;
	}

	/// @notice Sets the deployment block number in packed bits.
	function setDeployBlockNum(uint256 bits, uint256 deployBlockNum) internal pure returns (uint256) {
		bits &= ~(DEPLOY_BLOCKNUM_MASK << DEPLOY_BLOCKNUM_OFFSET);
		bits |= (deployBlockNum << DEPLOY_BLOCKNUM_OFFSET);
		return bits;
	}
}
