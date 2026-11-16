import { keccak_256 } from "@noble/hashes/sha3"

// Ethereum-compatible Keccak-256 for both browser and Node.js.
export function keccak256(data: Uint8Array): Uint8Array {
	return keccak_256(data)
}
