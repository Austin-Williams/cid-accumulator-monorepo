// Minimal IPLD dag-cbor encode/decode (drop-in for @ipld/dag-cbor)
import { CID } from "../ipfs/CID.js"
import type { DagCborEncodedData } from "../ipfs/types.js"

// CBOR major types
const MT_UINT = 0,
	MT_NEGINT = 1,
	MT_BYTES = 2,
	MT_STRING = 3,
	MT_ARRAY = 4,
	MT_OBJECT = 5,
	MT_TAG = 6,
	MT_SIMPLE = 7

// Helper: encode unsigned int (major type)
function encodeUint(val: number, mt: number): Uint8Array {
	if (val < 24) return new Uint8Array([(mt << 5) | val])
	if (val < 0x100) return new Uint8Array([(mt << 5) | 24, val])
	if (val < 0x10000) return new Uint8Array([(mt << 5) | 25, val >> 8, val & 0xff])
	if (val < 0x100000000)
		return new Uint8Array([(mt << 5) | 26, (val >>> 24) & 0xff, (val >>> 16) & 0xff, (val >>> 8) & 0xff, val & 0xff])
	throw new Error("Bigint not supported")
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
	const len = chunks.reduce((sum, c) => sum + c.length, 0)
	const out = new Uint8Array(len)
	let off = 0
	for (const c of chunks) {
		out.set(c, off)
		off += c.length
	}
	return out
}

function encode(val: unknown): DagCborEncodedData {
	if (val === null) return new Uint8Array([0xf6]) as DagCborEncodedData
	if (val === false) return new Uint8Array([0xf4]) as DagCborEncodedData
	if (val === true) return new Uint8Array([0xf5]) as DagCborEncodedData
	if (typeof val === "number") {
		if (Number.isInteger(val)) {
			if (val >= 0) return encodeUint(val, MT_UINT) as DagCborEncodedData
			else return encodeUint(-(val + 1), MT_NEGINT) as DagCborEncodedData
		} else {
			// float64
			const buf = new ArrayBuffer(9)
			const view = new DataView(buf)
			view.setUint8(0, 0xfb)
			view.setFloat64(1, val)
			return new Uint8Array(buf) as DagCborEncodedData
		}
	}
	if (typeof val === "string") {
		const strBytes = new TextEncoder().encode(val)
		return concatBytes(encodeUint(strBytes.length, MT_STRING), strBytes) as DagCborEncodedData
	}
	if (val instanceof Uint8Array) {
		return concatBytes(encodeUint(val.length, MT_BYTES), val) as DagCborEncodedData
	}
	if (Array.isArray(val)) {
		const parts = val.map(encode)
		return concatBytes(encodeUint(val.length, MT_ARRAY), ...parts) as DagCborEncodedData
	}
	if (val instanceof CID) {
		// IPLD: tag 42, bytes = 0x00 + CID bytes
		const tag = encodeUint(42, MT_TAG)
		let cidBytes: Uint8Array
		if (val.bytes instanceof Uint8Array) {
			cidBytes = val.bytes
		} else {
			const asCid = CID.asCID(val)
			if (!asCid) throw new Error("Invalid CID object passed to dagCbor encode")
			cidBytes = asCid.bytes
		}
		const tagged = concatBytes(new Uint8Array([0]), cidBytes)
		return concatBytes(tag, encode(tagged)) as DagCborEncodedData
	}
	if (typeof val === "object") {
		const parts = Object.entries(val).map(([key, value]) => concatBytes(encode(key), encode(value)))
		return concatBytes(encodeUint(parts.length, MT_OBJECT), ...parts) as DagCborEncodedData
	}
	throw new Error("Unsupported type for dag-cbor encode")
}

function decode(buf: DagCborEncodedData): unknown {
	let off = 0
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
	function requireBytes(length: number): void {
		if (length > buf.length - off) throw new Error("Unexpected end of data")
	}
	function _decode(): unknown {
		requireBytes(1)
		const head = buf[off++]
		const mt = head >> 5,
			val = head & 0x1f
		// Unsigned int
		let n = val
		if (mt !== MT_SIMPLE && val >= 24) {
			const width = val === 24 ? 1 : val === 25 ? 2 : val === 26 ? 4 : 0
			if (width === 0) throw new Error("Unsupported int size")
			requireBytes(width)
			// Bitwise operators would turn lengths >= 2^31 into negative numbers.
			n = width === 1 ? view.getUint8(off) : width === 2 ? view.getUint16(off) : view.getUint32(off)
			off += width
		}
		switch (mt) {
			case MT_UINT:
				return n
			case MT_NEGINT:
				return -1 - n
			case MT_BYTES: {
				requireBytes(n)
				const v = buf.slice(off, off + n)
				off += n
				return v
			}
			case MT_STRING: {
				requireBytes(n)
				const v = new TextDecoder().decode(buf.slice(off, off + n))
				off += n
				return v
			}
			case MT_ARRAY: {
				// Each item needs at least one byte; reject impossible counts before looping.
				requireBytes(n)
				const arr = []
				for (let i = 0; i < n; i++) arr.push(_decode())
				return arr
			}
			case MT_OBJECT: {
				requireBytes(n * 2)
				const obj: Record<string, unknown> = {}
				for (let i = 0; i < n; i++) {
					const k = _decode()
					if (typeof k !== "string") throw new Error("CBOR map keys must be strings")
					// Preserve keys such as "__proto__" as ordinary own properties.
					Object.defineProperty(obj, k, { value: _decode(), enumerable: true, writable: true, configurable: true })
				}
				return obj
			}
			case MT_TAG: {
				if (n === 42) {
					const tagged = _decode()
					if (!(tagged instanceof Uint8Array) || tagged[0] !== 0) throw new Error("Invalid CID tag")
					return CID.decode(tagged.slice(1))
				} else {
					throw new Error("Unsupported CBOR tag: " + n)
				}
			}
			case MT_SIMPLE:
				if (val === 20) return false
				if (val === 21) return true
				if (val === 22) return null
				if (val === 23) return undefined
				if (val === 27) {
					// float64
					requireBytes(8)
					const v = view.getFloat64(off)
					off += 8
					return v
				}
				throw new Error("Unsupported CBOR simple value: " + val)
		}
		throw new Error("Unsupported CBOR major type: " + mt)
	}
	const result = _decode()
	if (off !== buf.length) throw new Error("Extra bytes after CBOR decode")
	return result
}

export const code = 0x71 // dag-cbor multicodec code (decimal 113)
export { encode, decode }
