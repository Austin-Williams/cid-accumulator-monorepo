import type { CIDDataPair } from "../source/ipfs/types.js"
import * as dagCbor from "../source/utils/dagCbor.js"

export function varint(value: number): Uint8Array {
	const bytes: number[] = []
	do {
		const byte = value % 128
		value = Math.floor(value / 128)
		bytes.push(byte | (value > 0 ? 0x80 : 0))
	} while (value > 0)
	return Uint8Array.from(bytes)
}

// CAR v1 framing, with the requested root declared independently of the included blocks.
export function makeCar(root: CIDDataPair, blocks: CIDDataPair[]): Uint8Array {
	const header = dagCbor.encode({ roots: [root.cid], version: 1 })
	const parts = [varint(header.length), header]
	for (const block of blocks) {
		parts.push(
			varint(block.cid.bytes.length + block.dagCborEncodedData.length),
			block.cid.bytes,
			block.dagCborEncodedData
		)
	}
	return Buffer.concat(parts)
}
