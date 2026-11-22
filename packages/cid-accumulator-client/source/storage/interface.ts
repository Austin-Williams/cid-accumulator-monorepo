import type { LifecycleComponent } from "../types/common.js"

export interface StorageConfig {
	/** Filesystem path for Node storage. */
	nodeDbPath: string
	/** IndexedDB database name for browser storage. Defaults to "cid-accumulator". */
	browserDbName: string
}

/**
 * DB schema within one chain-ID/consumer-contract scope.
 * AccumulatorStorageAdapter prefixes the keys below and gives each scope its own coordination identity.
 * IpfsResolver storage (standalone light clients share verified CID blocks across scopes):
 * - "ipfs:block:{cidString}" - dagCborEncodedData
 * - "lastPayloadScope:{address}" - local startup lookup hint, validated against the on-chain root before use
 *
 * EventCacheService storage:
 * - "events:latestPolledBlock" - latest fully processed polling block
 * - "events:account:{account}:block:{blockNumber}" - complete JSON array of leaf indices for this consumer, including []
 *
 * Shared leaf data storage (populated via on-chain events, IPFS downloads, CID-walkbacks, MMRs, etc):
 * Invalidate shared leaf data only through coordinated chain rollback.
 *
 * "account:{address}:leaf:{leafIndex}": { // LeafRecord
 *   account: EthereumAddress,           // the emitting consumer contract's address
 *   leafIndex: number,                  // the leaf index
 *   payload: Uint8Array,                // the raw payload
 *   payloadCID?: CID<unknown, 113, 27, 1>, // CID<unknown, 113, 27, 1>.toString(), the CID of the payload itself, not the root CID,
 *   blockNumber?: number,               // block number (base 10) where the leaf was inserted
 *   previousInsertBlockNumber?: number, // block number (base 10) where the previous leaf was inserted
 *   mergeLeftHashes?: CID<unknown, 113, 27, 1>[] // multihash bodies of nodes merged during insertion
 *   rootCidAfterInsert?: CID<unknown, 113, 27, 1>, // root CID after this leaf was inserted
 *   insertionTrail?: CIDDataPair[],     // trail of CIDDataPair objects from insertion (excluding payloadCID/payload)
 *   peaksWithHeightsAfterInsert?: PeakWithHeight[] // peaks with heights after insertion
 * }
 */

// We use strings for both keys and values since that is compatible with most storage solutions
export interface Storage extends LifecycleComponent {
	/** Stable shared identity for adapters accessing the same database namespace in this process. */
	getIdentity?(): Promise<object>
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
