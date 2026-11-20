// shared/codec.ts
import { keccak256 } from "./hash.js"
import * as dagCbor from "./dagCbor.js"
import { CID } from "../ipfs/CID.js"
import type { DagCborEncodedData } from "../ipfs/types.js"
import type { CIDDataPair } from "../ipfs/types.js"
import type { NormalizedDataAppendedEvent } from "../ethereum/events.types.js"
import type { AccumulatorMetadata, LeafRecord, PeakWithHeight } from "../mmr/types.js"

interface Digest<Code, Size extends number = number> {
	code: Code // hash function code (e.g., 0x1b for keccak-256)
	digest: Uint8Array // the actual hash digest bytes
	size: Size // length of the digest in bytes
	bytes: Uint8Array // the full multihash bytes (code + length + digest)
}

export function hashToMultiformatsDigest(code: 0x1b, hash: Uint8Array): Digest<0x1b, 32> {
	// Multihash format: [code, length, ...digest]
	const bytes = new Uint8Array([code, hash.length, ...hash])
	return { code, digest: hash, size: 32, bytes }
}

export async function encodeBlock(
	value: unknown
): Promise<{ cid: CID<unknown, 113, 27, 1>; dagCborEncodedData: DagCborEncodedData }> {
	const encoded: DagCborEncodedData = dagCbor.encode(value)
	const hash = keccak256(encoded)
	const multihash = hashToMultiformatsDigest(0x1b, hash) // 0x1b is the code for keccak-256
	const cid = CID.createV1(dagCbor.code, multihash)
	return { cid, dagCborEncodedData: encoded }
}

// Encodes a link node as per DagCborDigestLib.encodeLinkNode in Solidity
export async function encodeLinkNode(
	left: CID<unknown, 113, 27, 1>,
	right: CID<unknown, 113, 27, 1>
): Promise<CID<unknown, 113, 27, 1>> {
	// Map(2) { "L": left, "R": right }
	const node = { L: left, R: right }
	const encoded = dagCbor.encode(node)
	const hash = keccak256(encoded)
	const multihash = hashToMultiformatsDigest(0x1b, hash) // 0x1b is the code for keccak-256
	return CID.createV1(dagCbor.code, multihash)
}

export function cidDataPairToStringForDB(pair: CIDDataPair): string {
	return JSON.stringify({
		cid: pair.cid.toString(),
		dagCborEncodedData: uint8ArrayToHexString(pair.dagCborEncodedData),
	})
}

export async function stringFromDBToCIDDataPair(s: string): Promise<CIDDataPair> {
	const { cid, dagCborEncodedData } = JSON.parse(s)
	return { cid: CID.parse(cid), dagCborEncodedData: hexStringToUint8Array(dagCborEncodedData) as DagCborEncodedData }
}

// Convert contract peak hex (digest) to the exact CID form used by mmr.peaks (wrap digest, do not hash)
export function contractPeakHexToMmrCid(bytes: Uint8Array): CID<unknown, 113, 27, 1> {
	const digest = hashToMultiformatsDigest(0x1b, bytes) // 0x1b = keccak-256
	return CID.create(1, 0x71, digest) // 0x71 = dag-cbor
}

// Converts a Uint8Array to a lowercase hex string (no 0x prefix).
export function uint8ArrayToHexString(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
}

// Converts a hex string (with or without 0x prefix) to a Uint8Array.
export function hexStringToUint8Array(hex: string): Uint8Array {
	const clean = hex.startsWith("0x") ? hex.slice(2) : hex
	if (clean.length % 2 !== 0) throw new Error("Hex string must have even length")
	const bytes = new Uint8Array(clean.length / 2)
	for (let i = 0; i < clean.length; i += 2) {
		bytes[i / 2] = parseInt(clean.slice(i, i + 2), 16)
	}
	return bytes
}

// Converts a NormalizedDataAppendedEvent to a JSON string (serializes payload and mergeLeftHashes)
export function NormalizedDataAppendedEventToString(event: NormalizedDataAppendedEvent): string {
	return JSON.stringify({
		leafIndex: event.leafIndex,
		previousInsertBlockNumber: event.previousInsertBlockNumber,
		payload: uint8ArrayToHexString(event.payload),
		mergeLeftHashes: event.mergeLeftHashes.map((cid) => cid.toString()),
		blockNumber: event.blockNumber,
	})
}

// Converts PeakWithHeight[] to a JSON string with cids as hex strings
export function peakWithHeightArrayToStringForDB(peaks: { cid: CID<unknown, 113, 27, 1>; height: number }[]): string {
	return JSON.stringify(peaks.map((p) => ({ cid: p.cid.toString(), height: p.height })))
}

// Converts a JSON string back to PeakWithHeight[] (cids from hex strings)
export async function stringToPeakWithHeightArray(str: string): Promise<PeakWithHeight[]> {
	const arr = JSON.parse(str)
	return Promise.all(
		arr.map(async (p: { cid: string; height: number }) => ({ cid: CID.parse(p.cid), height: p.height }))
	)
}

// Converts CIDDataPair[] to a JSON string with cids as hex strings
export function cidDataPairArrayToStringForDB(peaks: CIDDataPair[]): string {
	return JSON.stringify(
		peaks.map((p) => ({ cid: p.cid.toString(), dagCborEncodedData: uint8ArrayToHexString(p.dagCborEncodedData) }))
	)
}

// Converts a JSON string back to a CIDDataPair array
// This is the reverse of cidDataPairArrayToStringForDB
export async function stringToCidDataPairArray(str: string): Promise<CIDDataPair[]> {
	const arr = JSON.parse(str)
	return arr.map((p: { cid: string; dagCborEncodedData: string }) => ({
		cid: CID.parse(p.cid),
		dagCborEncodedData: hexStringToUint8Array(p.dagCborEncodedData) as DagCborEncodedData,
	}))
}

// Converts a JSON string back to a NormalizedDataAppendedEvent (parses payload and mergeLeftHashes)
export function stringToNormalizedDataAppendedEvent(str: string): NormalizedDataAppendedEvent {
	const obj = JSON.parse(str)
	return {
		account: obj.account,
		leafIndex: obj.leafIndex,
		previousInsertBlockNumber: obj.previousInsertBlockNumber,
		payload: hexStringToUint8Array(obj.payload),
		mergeLeftHashes: (obj.mergeLeftHashes ?? []).map((cidStr: string) => CID.parse(cidStr)),
		blockNumber: obj.blockNumber,
	}
}

export function getLeafRecordFromNormalizedDataAppendedEvent(event: NormalizedDataAppendedEvent): LeafRecord {
	if (
		event.account === undefined ||
		event.leafIndex === undefined ||
		event.payload === undefined ||
		event.blockNumber === undefined ||
		event.previousInsertBlockNumber === undefined ||
		event.mergeLeftHashes === undefined
	) {
		throw new Error("[codec] event is missing required fields. This should never happen.")
	}
	return {
		account: event.account,
		leafIndex: event.leafIndex,
		payload: event.payload,
		blockNumber: event.blockNumber,
		previousInsertBlockNumber: event.previousInsertBlockNumber,
		mergeLeftHashes: event.mergeLeftHashes,
	}
}

export function getEthereumAddressAsLeftPaddedBytes32HexString(address: string): string {
	// Remove 0x prefix if present
	let clean = address.startsWith("0x") ? address.slice(2) : address
	// Validate length (should be 40 hex chars for an address)
	if (clean.length !== 40) throw new Error("Invalid Ethereum address length")
	// Left pad with zeros to 64 chars (32 bytes)
	const padded = clean.padStart(64, "0")
	return "0x" + padded
}

export function isIpldLink(obj: unknown): obj is CID<unknown, 113, 27, 1> {
	return obj instanceof CID
}

export function isInternalNode(obj: unknown): obj is { L: CID<unknown, 113, 27, 1>; R: CID<unknown, 113, 27, 1> } {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"L" in obj &&
		"R" in obj &&
		(obj as any).L instanceof CID &&
		(obj as any).R instanceof CID
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
