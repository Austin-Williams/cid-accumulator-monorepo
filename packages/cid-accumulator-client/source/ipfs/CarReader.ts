import { CID } from './CID'
import * as dagCbor from '../utils/dagCbor'

// Reads a varint from a Uint8Array at a given offset. Returns [value, bytesRead]
function readVarint(buf: Uint8Array, offset: number): [number, number] {
	let result = 0
	let shift = 0
	let bytesRead = 0
	while (true) {
		const byte = buf[offset + bytesRead]
		result |= (byte & 0x7f) << shift
		bytesRead++
		if ((byte & 0x80) === 0) break
		shift += 7
	}
	return [result, bytesRead]
}

import type { DagCborEncodedData } from './types'

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

		// Decode header CBOR (using your dagCbor decoder)
		const headerBytes = bytes.slice(offset, offset + headerLen)
		dagCbor.decode(headerBytes as DagCborEncodedData) // parsed, but not used here
		offset += headerLen

		const blocks: Array<{ cid: CID<any, any, any, any>, bytes: Uint8Array }> = []

		while (offset < bytes.length) {
			// Read block length (varint)
			const [blockLen, blockLenBytes] = readVarint(bytes, offset)
			offset += blockLenBytes

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

// NOTE: You must implement CID.decodeWithLength to return [CID, length] for this to work.
// This implementation assumes CAR v1 format and basic block structure.
