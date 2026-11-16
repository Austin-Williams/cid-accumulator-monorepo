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
	const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data
	if (data.length < 256 || data.length % 2 !== 0 || /[^0-9a-fA-F]/.test(data)) {
		throw new Error("Invalid LeafAppended ABI data")
	}
	const byteLength = BigInt(data.length / 2)
	const readWord = (offset: number): bigint => BigInt("0x" + data.slice(offset * 2, (offset + 32) * 2))
	const readOffset = (headOffset: number): number => {
		const offset = readWord(headOffset)
		if (offset < 128n || offset % 32n !== 0n || offset > byteLength - 32n) {
			throw new Error("Invalid LeafAppended ABI offset")
		}
		return Number(offset)
	}

	// Validate complete uint256 offsets and lengths before allocating decoded data.
	const payloadOffset = readOffset(64)
	const mergeLeftHashesOffset = readOffset(96)
	const payloadLen = readWord(payloadOffset)
	const mergeLeftHashesLen = readWord(mergeLeftHashesOffset)
	const paddedPayloadLen = ((payloadLen + 31n) / 32n) * 32n
	if (BigInt(payloadOffset) + 32n + paddedPayloadLen > byteLength) {
		throw new Error("Invalid LeafAppended payload length")
	}
	// Each merge consumes a peak; the contract's five-bit peak count is at most 31.
	if (mergeLeftHashesLen > 31n || BigInt(mergeLeftHashesOffset) + 32n + mergeLeftHashesLen * 32n > byteLength) {
		throw new Error("Invalid LeafAppended merge hash count")
	}

	const payloadStart = (payloadOffset + 32) * 2
	const payload = hexStringToUint8Array(data.slice(payloadStart, payloadStart + Number(payloadLen) * 2))
	const mergeLeftHashes: CID<unknown, 113, 18, 1>[] = []
	const mergeCount = Number(mergeLeftHashesLen)
	for (let i = 0; i < mergeCount; i++) {
		const start = (mergeLeftHashesOffset + 32 + i * 32) * 2
		mergeLeftHashes.push(contractPeakHexToMmrCid(hexStringToUint8Array(data.slice(start, start + 64))))
	}

	return {
		// Account is the first indexed topic (topic[1])
		account: EthereumAddress.fromString("0x" + log.topics[1].slice(26)),
		leafIndex: Number(readWord(0)),
		payload,
		previousInsertBlockNumber: Number(readWord(32)),
		mergeLeftHashes,
		blockNumber: Number(log.blockNumber),
		...(log.blockHash === undefined ? {} : { blockHash: log.blockHash.toLowerCase() }),
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
		...(log.blockHash === undefined ? {} : { blockHash: log.blockHash.toLowerCase() }),
	}
}
