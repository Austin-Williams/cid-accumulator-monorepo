import type { LifecycleComponent } from "../types/common"
/**
 * DB Schema for CID Accumulator Singleton
 *	IpfsPinner storage:
 * - "ipfs:remote-pinned:service:{serviceName}:cid:{cidString}" - boolean indicating whether the CID has been remote pinned at the service
 *
 * IpfsResolver storage:
 * - "ipfs:block:{cidString}" - dagCborEncodedData
 *
 * AccountRegistry storage:
 * - "account-registry:singletonBirthdayBlock" - blockNumber
 * - "account-registry:lastProcessedBlock" - blockNumber
 * - "account-registry:account:{index}" - accountAddress
 *
 * EventCacheService storage:
 * - "events:block:{blockNumber}" - JSON array of account addresses with events in the block
 * - "events:account:{account}:block:{blockNumber}" - JSON array of the leafIndex of events for this account in this block
 *
 * Shared leaf data storage (populated via on-chain events, IPFS downloads, CID-walkbacks, MMRs, etc):
 * Never delete anything another service has already written.
 *
 * "account:{address}:leaf:{leafIndex}": { // LeafRecord
 *   account: EthereumAddress,           // the account address
 *   leafIndex: number,                  // the leaf index
 *   payload: Uint8Array,                // the raw payload
 *   payloadCID?: CID<unknown, 113, 18, 1>, // CID<unknown, 113, 18, 1>.toString(), the CID of the payload itself, not the root CID,
 *   blockNumber?: number,               // block number (base 10) where the leaf was inserted
 *   previousInsertBlockNumber?: number, // block number (base 10) where the previous leaf was inserted
 *   mergeLeftHashes?: CID<unknown, 113, 18, 1>[] // multihash bodies of nodes merged during insertion
 *   rootCidAfterInsert?: CID<unknown, 113, 18, 1>, // root CID after this leaf was inserted
 *   insertionTrail?: CIDDataPair[],     // trail of CIDDataPair objects from insertion (excluding payloadCID/payload)
 *   peaksWithHeightsAfterInsert?: PeakWithHeight[] // peaks with heights after insertion
 * }
 */

// We use strings for both keys and values since that is compatible with most storage solutions
export interface Storage extends LifecycleComponent {
	put(key: string, value: string): Promise<void>
	get(key: string): Promise<string | undefined>
	delete(key: string): Promise<void>
	open(): Promise<void>
	close(): Promise<void>
	// Explicitly persist in-memory data to disk (if supported by the adapter)
	persist(): Promise<void>
	// Returns an async iterator over all records whose keys start with the given prefix.
	iterate(keyPrefix: string): AsyncIterable<{ key: string; value: string }>
	// Lifecycle methods (can noop if not needed)
	init(): Promise<void>
	start(): Promise<void>
	stop(): void
}
