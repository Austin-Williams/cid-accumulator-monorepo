import { keccak_256 } from "@noble/hashes/sha3"

import { CID } from "../ipfs/CID.js"
import { contractPeakHexToMmrCid, hexStringToUint8Array } from "../utils/codec.js"
import { EthereumAddress } from "./EthereumAddress.js"
import { LEAF_APPENDED_EVENT_SIGNATURE } from "../utils/constants.js"

import type { AccumulatorMetadata } from "../mmr/types.js"
import type { DagCborEncodedData } from "../ipfs/types.js"
import type {
	NormalizedLeafAppendedEvent,
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
	if (log.topics?.length !== 1 || log.topics[0]?.toLowerCase() !== getEventTopic(LEAF_APPENDED_EVENT_SIGNATURE)) {
		throw new Error("Invalid LeafAppended event topic")
	}
	const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data
	if (data.length < 256 || data.length % 2 !== 0 || /[^0-9a-fA-F]/.test(data)) {
		throw new Error("Invalid LeafAppended ABI data")
	}
	const byteLength = BigInt(data.length / 2)
	const readWord = (offset: number): bigint => BigInt("0x" + data.slice(offset * 2, (offset + 32) * 2))
	const metadata = readWord(0)
	if (metadata > 0xffffffffffffffffn) {
		throw new Error("Invalid LeafAppended metadata")
	}
	// Validate complete uint256 offsets and lengths before allocating decoded data.
	const offset = readWord(32)
	if (offset !== 64n) {
		throw new Error("Invalid LeafAppended ABI offset")
	}
	const combinedLen = readWord(Number(offset))
	if (offset + 32n + combinedLen !== byteLength) {
		throw new Error("Invalid LeafAppended combined length")
	}

	// Unpack before converting to Number: the combined uint64 can exceed safe integer precision.
	const leafIndex = metadata & 0xffffffffn
	let mergeCount = 0
	for (let index = leafIndex; (index & 1n) !== 0n; index >>= 1n) mergeCount++
	const mergeHashesLen = BigInt(mergeCount) * 32n
	// Each merge consumes a peak; the contract's five-bit peak count is at most 31.
	if (mergeCount > 31 || combinedLen !== 32n + mergeHashesLen) {
		throw new Error("Invalid LeafAppended merge hash count")
	}

	// The fixed-size payload occupies the first word; the remaining words are consumed peaks.
	const payloadStart = (Number(offset) + 32) * 2
	const hashesStart = payloadStart + 64
	const payload = hexStringToUint8Array(data.slice(payloadStart, hashesStart))
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
