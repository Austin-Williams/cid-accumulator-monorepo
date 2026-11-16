import { CID } from './CID.js'
import * as dagCbor from '../utils/dagCbor.js'
import type { DagCborEncodedData } from './types.js'

// Reads a varint from a Uint8Array at a given offset. Returns [value, bytesRead]
function readVarint(buf: Uint8Array, offset: number): [number, number] {
	let result = 0
	let bytesRead = 0
	// At most eight bytes can encode a safe JavaScript integer.
	for (let shift = 0; shift <= 49; shift += 7) {
		if (offset + bytesRead >= buf.length) throw new Error("Truncated CAR length")
		const byte = buf[offset + bytesRead]
		result += (byte & 0x7f) * 2 ** shift
		if (!Number.isSafeInteger(result)) throw new Error("CAR length exceeds safe integer range")
		bytesRead++
		if ((byte & 0x80) === 0) return [result, bytesRead]
	}
	throw new Error("CAR length exceeds safe integer range")
}

export class CarReader {
	// Allow bytes to be either Uint8Array or DagCborEncodedData for downstream compatibility
	private blocksArr: Array<{ cid: CID<any, any, any, any>, bytes: Uint8Array | DagCborEncodedData }>
	private constructor(blocks: Array<{ cid: CID<any, any, any, any>, bytes: Uint8Array | DagCborEncodedData }>) {
		this.blocksArr = blocks
	}

	static async fromBytes(bytes: Uint8Array): Promise<CarReader> {
		let offset = 0

		// Decode header length (varint)
		const [headerLen, headerLenBytes] = readVarint(bytes, offset)
		offset += headerLenBytes
		if (headerLen > bytes.length - offset) throw new Error("Truncated CAR header")

		// Validate the header before accepting any blocks.
		const headerBytes = bytes.slice(offset, offset + headerLen)
		const header = dagCbor.decode(headerBytes as DagCborEncodedData)
		if (
			header === null ||
			typeof header !== "object" ||
			Array.isArray(header) ||
			!Object.prototype.hasOwnProperty.call(header, "version") ||
			header.version !== 1 ||
			!Object.prototype.hasOwnProperty.call(header, "roots") ||
			!Array.isArray(header.roots) ||
			!header.roots.every((root: unknown) => root instanceof CID)
		) {
			throw new Error("Invalid CAR v1 header")
		}
		offset += headerLen

		const blocks: Array<{ cid: CID<any, any, any, any>, bytes: Uint8Array }> = []

		while (offset < bytes.length) {
			// Read block length (varint)
			const [blockLen, blockLenBytes] = readVarint(bytes, offset)
			offset += blockLenBytes
			if (blockLen === 0 || blockLen > bytes.length - offset) throw new Error("Invalid CAR block length")

			const blockBytes = bytes.slice(offset, offset + blockLen)
			let blockOffset = 0

			// Read CID (using your CID class)
			const [cid, cidLen] = CID.decodeWithLength(blockBytes)
			blockOffset += cidLen

			// The rest is the block data
			const data = blockBytes.slice(blockOffset)

			blocks.push({ cid, bytes: data })
			offset += blockLen
		}

		return new CarReader(blocks)
	}

	async *blocks() {
		for (const block of this.blocksArr) {
			yield block
		}
	}
}
