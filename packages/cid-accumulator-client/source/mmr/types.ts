import type { EthereumAddress } from "../ethereum/EthereumAddress"
import type { CID } from "../ipfs/CID"
import type { DagCborEncodedData } from "../ipfs/types"
import type { CIDDataPair } from "../ipfs/types"

export type AccumulatorMetadata = {
	peakHeights: number[]
	peakCount: number
	leafCount: number
	previousInsertBlockNumber: number
	deployBlockNumber: number
}

// Represents a single MMR peak with its CID and height.
export type PeakWithHeight = { cid: CID<unknown, 113, 18, 1>; height: number }

// contains the CID and data for the leaf, all new intermediate nodes, and the new root node
export type MMRLeafAppendedTrail = {
	cid: CID<unknown, 113, 18, 1>
	dagCborEncodedData: DagCborEncodedData
}[]

// Represents all relevant data for a leaf/event in the accumulator.
export type LeafRecord = {
	account: EthereumAddress
	leafIndex: number
	payload: Uint8Array
	payloadCID?: CID<unknown, 113, 18, 1>
	blockNumber?: number // block number (base 10) where the leaf was inserted
	previousInsertBlockNumber?: number // block number (base 10) where the previous leaf was inserted
	mergeLeftHashes?: CID<unknown, 113, 18, 1>[] // multihash bodies of nodes merged during insertion
	rootCidAfterInsert?: CID<unknown, 113, 18, 1>
	insertionTrail?: CIDDataPair[] // trail of CIDDataPair objects from insertion (excluding payloadCID/payload)
	peaksWithHeightsAfterInsert?: PeakWithHeight[] // This is the set of active peaks of the mmr AFTER this leaf/event is inserted.
}
