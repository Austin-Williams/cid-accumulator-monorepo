import type { CID } from "../ipfs/CID"
import type { EthereumAddress } from "./EthereumAddress"

export interface RawEthLog {
	address: string // Contract address
	topics: readonly string[] // Array of 32-byte hex strings
	data: string // Hex string, ABI-encoded data
	blockNumber: number // Block number
}

export type NormalizedLeafAppendedEvent = {
	account: EthereumAddress // indexed
	leafIndex: number
	previousInsertBlockNumber: number
	payload: Uint8Array
	mergeLeftHashes: CID<unknown, 113, 18, 1>[]
	blockNumber: number
}

export type NormalizedNewAccountInitializedEvent = {
	account: EthereumAddress
	blockNumber: number
}
