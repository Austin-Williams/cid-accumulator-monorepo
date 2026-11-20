import { keccak_256 } from "@noble/hashes/sha3"

import { CID } from "../ipfs/CID.js"
import { contractPeakHexToMmrCid, hexStringToUint8Array } from "../utils/codec.js"
import { EthereumAddress } from "./EthereumAddress.js"
import { DATA_APPENDED_EVENT_SIGNATURE } from "../utils/constants.js"

import type { AccumulatorMetadata } from "../mmr/types.js"
import type { DagCborEncodedData } from "../ipfs/types.js"
import type {
	NormalizedDataAppendedEvent,
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

export function parseGetStateResult(hex: string): [bigint, DagCborEncodedData[]] {
	const data = hex.startsWith("0x") ? hex.slice(2) : hex
	if (data.length < 64 + 32 * 64) throw new Error("Result too short for ABI-encoded tuple")
	const merkleMountainRangeMetaBits = BigInt("0x" + data.slice(0, 64))
	const peaks: DagCborEncodedData[] = []
	for (let i = 0; i < 32; i++) {
		const start = 64 + i * 64
		const end = start + 64
		peaks.push(hexStringToUint8Array(data.slice(start, end)) as DagCborEncodedData)
	}
	return [merkleMountainRangeMetaBits, peaks]
}

export function parseAccumulatorMetaBits(merkleMountainRangeMetaBits: bigint): AccumulatorMetadata {
	const bits = merkleMountainRangeMetaBits
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

export async function parseDataAppendedLog(log: RawEthLog): Promise<NormalizedDataAppendedEvent> {
	if (log.topics?.length !== 1 || log.topics[0]?.toLowerCase() !== getEventTopic(DATA_APPENDED_EVENT_SIGNATURE)) {
		throw new Error("Invalid DataAppendedToCIDAccumulator event topic")
	}
	const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data
	if (data.length < 256 || data.length % 2 !== 0 || /[^0-9a-fA-F]/.test(data)) {
		throw new Error("Invalid DataAppendedToCIDAccumulator ABI data")
	}
	const byteLength = BigInt(data.length / 2)
	const readWord = (offset: number): bigint => BigInt("0x" + data.slice(offset * 2, (offset + 32) * 2))
	const metadata = readWord(0)
	if (metadata > 0xffffffffffffffffn) {
		throw new Error("Invalid DataAppendedToCIDAccumulator metadata")
	}
	// Validate complete uint256 offsets and lengths before allocating decoded data.
	const offset = readWord(64)
	if (offset !== 96n) {
		throw new Error("Invalid DataAppendedToCIDAccumulator ABI offset")
	}
	const mergeHashesLen = readWord(Number(offset))
	if (offset + 32n + mergeHashesLen !== byteLength) {
		throw new Error("Invalid DataAppendedToCIDAccumulator merge hashes length")
	}

	// Unpack before converting to Number: the combined uint64 can exceed safe integer precision.
	const leafIndex = metadata & 0xffffffffn
	let mergeCount = 0
	for (let index = leafIndex; (index & 1n) !== 0n; index >>= 1n) mergeCount++
	// Each merge consumes a peak; the contract's five-bit peak count is at most 31.
	if (mergeCount > 31 || mergeHashesLen !== BigInt(mergeCount) * 32n) {
		throw new Error("Invalid DataAppendedToCIDAccumulator merge hash count")
	}

	// The payload is the second head word; the dynamic body contains consumed peaks' hashes.
	const payload = hexStringToUint8Array(data.slice(64, 128))
	const hashesStart = (Number(offset) + 32) * 2
	const mergeLeftHashes: CID<unknown, 113, 27, 1>[] = []
	for (let i = 0; i < mergeCount; i++) {
		const start = hashesStart + i * 64
		mergeLeftHashes.push(contractPeakHexToMmrCid(hexStringToUint8Array(data.slice(start, start + 64))))
	}

	return {
		account: EthereumAddress.fromString(log.address),
		leafIndex: Number(leafIndex),
		payload,
		previousInsertBlockNumber: Number(metadata >> 32n),
		mergeLeftHashes,
		blockNumber: Number(log.blockNumber),
		...(log.blockHash === undefined ? {} : { blockHash: log.blockHash.toLowerCase() }),
	}
}
