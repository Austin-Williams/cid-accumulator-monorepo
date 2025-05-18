import { keccak_256 } from "@noble/hashes/sha3"

import { CID } from "../ipfs/CID.js"
import { contractPeakHexToMmrCid, hexStringToUint8Array } from "../utils/codec.js"
import { EthereumAddress } from "./EthereumAddress.js"

import type { AccumulatorMetadata } from "../mmr/types.js"
import type { DagCborEncodedData } from "../ipfs/types.js"
import type {
	NormalizedLeafAppendedEvent,
	NormalizedNewAccountInitializedEvent,
	RawEthLog,
} from "./events.types.js"

export function getSelector(signature: string): string {
	const hash: Uint8Array = keccak_256(signature)
	const selectorHex = Array.from(hash.slice(0, 4))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
	return "0x" + selectorHex
}

export function getEventTopic(signature: string): string {
	const hash: Uint8Array = keccak_256(signature)
	return (
		"0x" +
		Array.from(hash)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")
	)
}

// Parses the ABI-encoded result of a contract call to getRootCID -> bytes.
// @param abiResult string (0x-prefixed hex string)
// @returns Uint8Array (decoded bytes)

export function parseGetRootCIDResult(abiResult: string): Uint8Array {
	// ABI encoding for bytes: 32 bytes offset, then 32 bytes length, then data
	const buf = hexStringToUint8Array(abiResult)
	if (buf.length < 64) throw new Error("Result too short for ABI-encoded bytes")
	// Read length as big-endian uint32 from offset 60
	const len = (buf[60] << 24) | (buf[61] << 16) | (buf[62] << 8) | buf[63]
	if (buf.length < 64 + len) throw new Error("Result too short for declared length")
	return buf.slice(64, 64 + len)
}

export function parseGetStateResult(hex: string): [bigint, DagCborEncodedData[]] {
	const data = hex.startsWith("0x") ? hex.slice(2) : hex
	if (data.length < 64 + 32 * 64) throw new Error("Result too short for ABI-encoded tuple")
	const mmrMetaBits = BigInt("0x" + data.slice(0, 64))
	const peaks: DagCborEncodedData[] = []
	for (let i = 0; i < 32; i++) {
		const start = 64 + i * 64
		const end = start + 64
		peaks.push(hexStringToUint8Array(data.slice(start, end)) as DagCborEncodedData)
	}
	return [mmrMetaBits, peaks]
}

export function parseAccumulatorMetaBits(mmrMetaBits: bigint): AccumulatorMetadata {
	const bits = mmrMetaBits
	const peakHeights: number[] = []
	for (let i = 0; i < 32; i++) {
		peakHeights.push(Number((bits >> BigInt(i * 5)) & 0x1fn))
	}
	const peakCount = Number((bits >> 160n) & 0x1fn)
	const leafCount = Number((bits >> 165n) & 0xffffffffn)
	const previousInsertBlockNumber = Number((bits >> 197n) & 0xffffffffn)
	const deployBlockNumber = Number((bits >> 229n) & 0x7ffffffn)

	return {
		peakHeights,
		peakCount,
		leafCount,
		previousInsertBlockNumber,
		deployBlockNumber,
	}
}

export async function parseLeafAppendedLog(log: RawEthLog): Promise<NormalizedLeafAppendedEvent> {
	// Helper to parse a 32-byte hex as uint32 (big-endian)
	// Data field parsing
	const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data

	// leafIndex: first 32 bytes (offset 0)
	const leafIndex = parseInt(data.slice(0, 64), 16)
	// previousInsertBlockNumber: next 32 bytes (offset 32)
	const previousInsertBlockNumber = parseInt(data.slice(64, 128), 16)

	// Offsets for dynamic fields (payload, mergeLeftHashes)
	const payloadOffset = parseInt(data.slice(128, 192), 16) * 2
	const mergeLeftHashesOffset = parseInt(data.slice(192, 256), 16) * 2

	// payload: at payloadOffset, first 32 bytes = length, then bytes
	const payloadLen = parseInt(data.slice(payloadOffset, payloadOffset + 64), 16)
	const payloadHex = data.slice(payloadOffset + 64, payloadOffset + 64 + payloadLen * 2)
	const payload = hexStringToUint8Array(payloadHex)

	// mergeLeftHashes: at mergeLeftHashesOffset, first 32 bytes = length, then array of bytes32
	const mergeLeftHashesLen = parseInt(data.slice(mergeLeftHashesOffset, mergeLeftHashesOffset + 64), 16)
	const mergeLeftHashes: Uint8Array[] = []
	let mergeLeftHashesCursor = mergeLeftHashesOffset + 64
	for (let i = 0; i < mergeLeftHashesLen; i++) {
		const hexStr = data.slice(mergeLeftHashesCursor, mergeLeftHashesCursor + 64)
		mergeLeftHashes.push(hexStringToUint8Array(hexStr))
		mergeLeftHashesCursor += 64
	}
	const mergeLeftHashesAsCIDs: CID<unknown, 113, 18, 1>[] = await Promise.all(
		mergeLeftHashes.map(async (input) => contractPeakHexToMmrCid(input))
	)

	return {
		// Account is the first indexed topic (topic[1])
		account: EthereumAddress.fromString("0x" + log.topics[1].slice(26)),
		leafIndex,
		payload,
		previousInsertBlockNumber,
		mergeLeftHashes: mergeLeftHashesAsCIDs,
		blockNumber: Number(log.blockNumber),
	}
}

/**
 * Parse a NewAccountInitialized event log
 * @param log The raw Ethereum log
 * @returns A normalized NewAccountInitialized event
 */
export function parseNewAccountInitializedLog(log: RawEthLog): NormalizedNewAccountInitializedEvent {
	// For non-indexed parameters, we need to decode the data field
	// The data field contains the 32-byte address padded to 32 bytes
	const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data

	// Extract the address from the data (last 20 bytes of the 32-byte field)
	// Skip the first 12 bytes (24 hex chars) of padding
	const accountAddress = data.slice(24, 64)

	return {
		account: EthereumAddress.fromString("0x" + accountAddress),
		blockNumber: Number(log.blockNumber),
	}
}
