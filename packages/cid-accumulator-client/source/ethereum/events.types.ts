import type { CID } from "../ipfs/CID.js"
import type { EthereumAddress } from "./EthereumAddress.js"

export type ChainBlock = {
	number: number
	hash: string
	parentHash: string
}

export type BlockReference = string | { blockHash: string; requireCanonical: true }

export interface RawEthLog {
	address: string // Contract address
	topics: readonly string[] // Array of 32-byte hex strings
	data: string // Hex string, ABI-encoded data
	blockNumber: number | string // RPC quantities are hexadecimal strings.
	blockHash?: string
}

export type NormalizedLeafAppendedEvent = {
	account: EthereumAddress // The contract emitting the event.
	leafIndex: number
	previousInsertBlockNumber: number
	payload: Uint8Array
	mergeLeftHashes: CID<unknown, 113, 27, 1>[]
	blockNumber: number
	blockHash?: string
}
