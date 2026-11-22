import { getChainState, ChainChangedError, type ChainState, type ChainSnapshot } from "../../services/ChainState.js"
import type { ChainBlock } from "../../ethereum/events.types.js"
import { createLogger } from "../../utils/logging.js"
import { getLeafPayloadFromDB, putLeafRecordInDB } from "../../storage/utils.js"
import { peakWithHeightArrayToStringForDB, uint8ArrayToHexString } from "../../utils/codec.js"
import { isNodeJs } from "../../utils/envDetection.js"
import { computePreviousRootCIDAndPeaksWithHeights, getRootCIDFromPeaks } from "../../mmr/utils.js"
import { MerkleMountainRange } from "../../mmr/MerkleMountainRange.js"

import type { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import type { CID } from "../../ipfs/CID.js"
import type { DataClientDependencies, RootSnapshot } from "./DataClient.types.js"
import type { EthereumAddress } from "../../ethereum/EthereumAddress.js"
import type { EventCacheService } from "../../services/EventCacheService.js"
import type { AccumulatorMetadata, LeafRecord, PeakWithHeight } from "../../mmr/types.js"
import type { Logger } from "../../types/common.js"
import type { Storage } from "../../storage/interface.js"
import type { IpfsResolver } from "../../ipfs/IpfsResolver.js"

export type DataClientEvent =
	| { type: "append"; record: LeafRecord }
	| { type: "rollback"; account: EthereumAddress; firstInvalidLeafIndex: number; block: ChainBlock }

const MAX_SYNC_SNAPSHOT_REFRESHES = 3

// Newer cached leaves may be valid events received after the contract snapshot.
class CacheAheadOfSnapshotError extends Error {}

/**
 * Retrieves and verifies the configured consumer contract's accumulator data.
 * Uses the "CID-Walkback" method to look for payload data on IPFS, and will fully sync from
 * contract events (eventually) if it can't find anything on IPFS. It relies on the EventCacheService
 * to fetch DataAppendedToCIDAccumulator events as needed.
 */
export class DataClient {
	/** The emitting consumer contract's address, used to identify its leaf records. */
	public readonly account: EthereumAddress
	public readonly storage: Storage
	public readonly ipfsResolver: IpfsResolver
	public readonly accumulatorContract: AccumulatorContract
	public readonly eventCacheService: EventCacheService

	public syncing: boolean = false
	private syncPromise?: Promise<void>
	private subscribers: Array<(event: DataClientEvent) => void> = []
	private activeSnapshot?: ChainSnapshot
	private unsubscribeRollback?: () => void
	private connectionGeneration = 0
	/** Verified, read-only payloads available before live chain tracking acquires the shared database. */
	protected rootSnapshot?: RootSnapshot
	public get chain(): Promise<ChainState> { return getChainState(this.storage, this.accumulatorContract) }
	protected logger: Logger

	public completedInitialSync: boolean = false

	/**
	 * @notice Creates a new DataClient instance
	 * @param dependencies Services bound to the same accumulator contract and storage scope.
	 */
	constructor(dependencies: DataClientDependencies) {
		this.account = dependencies.accumulatorContract.address
		this.accumulatorContract = dependencies.accumulatorContract
		this.storage = dependencies.storage
		this.eventCacheService = dependencies.eventCacheService
		this.ipfsResolver = dependencies.ipfsResolver
		this.logger = createLogger(`Client ${this.account.toString()}`)
	}

	/**
	 * @notice Syncs this account's data from the latest leaf index down to the last contiguous leaf index in storage
	 * @dev Concurrent callers share the current sync's result or error. Failed syncs can be retried.
	 * Success requires the cached payload count and reconstructed root to match the fetched contract state.
	 * Newer cached leaves trigger bounded snapshot refreshes when the contract's leaf count has advanced.
	 * @return A promise that resolves when syncing is complete
	 */
	public sync(): Promise<void> {
		if (this.syncPromise) return this.syncPromise
		const connectionGeneration = this.connectionGeneration
		this.syncing = true
		this.completedInitialSync = false
		this.syncPromise = Promise.resolve().then(async () => {
			const chain = await this.chain
			if (connectionGeneration === this.connectionGeneration) this.connectChain(chain)
			for (let attempt = 0; ; attempt++) {
				let snapshot: ChainSnapshot | undefined
				try {
					snapshot = await chain.snapshot()
					this.activeSnapshot = snapshot
					let state = await this.accumulatorContract.getCIDAccumulatorState({ blockHash: snapshot.block.hash, requireCanonical: true })
					let snapshotRefreshes = 0
					while (true) {
						const { meta, peaks } = state
						const current = this.activeSnapshot!
						await chain.commit(current, () => chain.trackAccount(this.account, meta.leafCount, meta.previousInsertBlockNumber))
						const root = await getRootCIDFromPeaks(peaks.map(p => p.cid))
						await this.syncBackwardsFromLatest(meta, peaks, root)
						await chain.ensureCanonical(current)
						try {
							await this.verifyCachedPayloads(meta.leafCount, root)
							await chain.ensureCanonical(current)
							await chain.commit(current, async () => { this.completedInitialSync = true })
							return
						} catch (error) {
							if (!(error instanceof CacheAheadOfSnapshotError)) throw error
							const next = await chain.snapshot()
							const latest = await this.accumulatorContract.getCIDAccumulatorState({ blockHash: next.block.hash, requireCanonical: true })
							if (latest.meta.leafCount <= meta.leafCount) throw error
							if (snapshotRefreshes++ >= MAX_SYNC_SNAPSHOT_REFRESHES) {
								throw new Error(
									`[DataClient] Contract kept advancing during sync for ${this.account}; retry sync() to verify a fresh snapshot.`,
									{ cause: error }
								)
							}
							this.activeSnapshot = next
							state = latest
						}
					}
				} catch (error) {
					// A canonical-state RPC may reject before returning any data. Reconcile that
					// snapshot too, so this is retriable when its block was replaced.
					const failedSnapshot = this.activeSnapshot ?? snapshot
					let syncError = error
					if (failedSnapshot) {
						try { await chain.ensureCanonical(failedSnapshot) } catch (changed) { syncError = changed }
					}
					if (!(syncError instanceof ChainChangedError) || attempt >= MAX_SYNC_SNAPSHOT_REFRESHES) throw syncError
				}
			}
		}).finally(() => {
			this.syncing = false
			this.syncPromise = undefined
			this.activeSnapshot = undefined
		})
		return this.syncPromise
	}

	/** Attach before lifecycle services can recover or publish chain events.
	 * @internal A resolved chain lets lifecycle owners attach a client synchronously.
	 */
	public async connectChainNotifications(source?: ChainState): Promise<void> {
		const generation = this.connectionGeneration
		const chain = source ?? await this.chain
		if (generation === this.connectionGeneration) this.connectChain(chain)
	}

	private connectChain(chain: ChainState): void {
		if (this.unsubscribeRollback) return
		const stopReset = chain.subscribeReset(() => { this.completedInitialSync = false })
		const stopRollback = chain.subscribeRollback(event => {
			if (event.account.toString() !== this.account.toString()) return
			this.completedInitialSync = false
			this.notifySubscribers({ type: "rollback", account: this.account, firstInvalidLeafIndex: event.firstInvalidLeafIndex, block: event.block })
			// Recovery may be triggered by another client sharing the database.
			queueMicrotask(() => {
				if (this.unsubscribeRollback) this.sync().catch(error => this.logger.error(`Reorganization sync failed: ${error}`))
			})
		})
		this.unsubscribeRollback = () => { stopReset(); stopRollback() }
	}

	/** Lifecycle owners detach retained clients when stopped. Explicit sync reconnects them. */
	public disconnectChain(): void {
		this.connectionGeneration++
		this.unsubscribeRollback?.()
		this.unsubscribeRollback = undefined
	}

	private async write(operation: () => Promise<void>): Promise<void> {
		if (!this.activeSnapshot) throw new Error("Account writes require a sync snapshot")
		await (await this.chain).commit(this.activeSnapshot, operation)
	}

	private async put(key: string, value: string): Promise<void> {
		await this.write(() => this.storage.put(key, value))
	}

	/**
	 * @notice Handles a new leaf appended event for this account. Simply passes it along to any subscribers.
	 * @dev Called by LightClient when it learns about a new DataAppendedToCIDAccumulator event.
	 * @param event The leaf record containing the new leaf data (includes payload)
	 * @return A promise that resolves when the event has been processed
	 */
	public onDataAppended(event: LeafRecord): void {
		// Notify all subscribers about the new leaf record
		this.notifySubscribers({ type: "append", record: event })

		return
	}

	// STORAGE GETTERS

	/**
	 * @notice Returns the highest leaf index that has data available in storage
	 * @dev This is a wrapper around getHighestContiguousLeafIndexWithData
	 * @return The highest contiguous leaf index with data
	 */
	public async getHighestIndex(): Promise<number> {
		if (this.rootSnapshot) return this.rootSnapshot.payloads.length - 1
		return (await this.chain).read(() => this.getHighestContiguousLeafIndexWithData())
	}

	/**
	 * @notice Retrieves the leaf record data for a specific leaf index
	 * @param leafIndex The index of the leaf to retrieve
	 * @returns The hex string (no 0x prefix) of the payload for leafIndex
	 */
	public async getPayload(leafIndex: number): Promise<string | undefined> {
		if (this.rootSnapshot) return this.rootSnapshot.payloads[leafIndex]
		return (await this.chain).read(() => this.readPayload(leafIndex))
	}

	private async readPayload(leafIndex: number): Promise<string | undefined> {
		const payload = await getLeafPayloadFromDB(this.storage, this.account, leafIndex)
		return payload === undefined ? undefined : uint8ArrayToHexString(payload)
	}

	/**
	 * @notice Retrieves a range of leaf payloads
	 * @param fromIndex The starting leaf index (inclusive)
	 * @param toIndex The ending leaf index (inclusive)
	 * @returns Array of objects containing the leaf index and hex-encoded payload
	 */
	public async getPayloadInRange(
		fromIndex: number,
		toIndex: number
	): Promise<Array<{ index: number; payload: string }>> {
		if (fromIndex < 0) throw new Error(`[DataClient] fromIndex must be >= 0, got ${fromIndex}`)
		if (toIndex < fromIndex) throw new Error(`[DataClient] toIndex must be >= fromIndex, got ${toIndex} < ${fromIndex}`)
		if (this.rootSnapshot) {
			return this.rootSnapshot.payloads.slice(fromIndex, toIndex + 1).map((payload, i) => ({ index: fromIndex + i, payload }))
		}
		return (await this.chain).read(async () => {
			const highestIndex = await this.getHighestContiguousLeafIndexWithData()
			if (fromIndex > highestIndex) return [] // No data in this range

			// Adjust toIndex if it exceeds the highest available index
			toIndex = Math.min(toIndex, highestIndex)

			const results: Array<{ index: number; payload: string }> = []

			// Process each index sequentially
			for (let i = fromIndex; i <= toIndex; i++) {
				const payload = await this.readPayload(i)
				// An empty string represents a valid payload with zero bytes.
				if (payload !== undefined) {
					results.push({ index: i, payload })
				} else {
					throw new Error(`[DataClient] No payload found for leaf index ${i}. This should never happen.`)
				}
			}

			// Sort by index to ensure consistent order
			return results.sort((a, b) => a.index - b.index)
		})
	}

	/**
	 * @notice Subscribe to new leaf records for this account
	 * @param callback Function to call when a new leaf record is received
	 * @returns Unsubscribe function
	 */
	public subscribe(callback: (event: DataClientEvent) => void): () => void {
		// Add the callback to the subscribers list
		this.subscribers.push(callback)
		// Return an unsubscribe function
		return () => {
			const index = this.subscribers.indexOf(callback)
			if (index !== -1) {
				this.subscribers.splice(index, 1)
			}
		}
	}

	/**
	 * @notice Downloads all payload data for this account as a JSON file
	 * @dev In Node.js, writes to a file on disk using streaming. In browsers, uses standard download.
	 * For large datasets, this approach is more memory-efficient than loading all data at once.
	 * @return In Node.js, returns the file path. In browsers, returns the filename
	 */
	public async downloadAllPayloads(): Promise<string> {
		if (isNodeJs()) {
			// Node.js: use streaming to write directly to disk
			const fsStream = await import("fs")
			const filePath = `${this.account}-data-${Date.now()}.json`

			// Create a write stream to the file
			const writeStream = fsStream.createWriteStream(filePath)

			// Write the opening bracket for the JSON array
			writeStream.write("[\n")

			// Track if we've written any items yet
			let isFirst = true

			// Iterate through all payload entries and write them directly to the stream
			for await (const { index, payload } of this.iterate()) {
				// Add a comma before each item except the first
				if (!isFirst) {
					writeStream.write(",\n")
				} else {
					isFirst = false
				}

				// Write this item to the stream
				const item = JSON.stringify({ index, data: payload }, null, 2)
				writeStream.write(item)
			}

			// Write the closing bracket for the JSON array
			writeStream.write("\n]")

			// Close the stream and wait for it to finish
			await new Promise<void>((resolve, reject) => {
				writeStream.end(() => resolve())
				writeStream.on("error", reject)
			})

			this.logger.log(`Data written to ${filePath}`)
			return filePath
		} else {
			// Fallback for browsers without streaming support: collect all data in memory
			const allData: Array<{ index: number; data: string }> = []
			for await (const { index, payload } of this.iterate()) {
				allData.push({ index, data: payload })
			}

			// Create a JSON string from the collected data
			const json = JSON.stringify(allData, null, 2)

			// Create a download link
			const blob = new Blob([json], { type: "application/json" })
			const url = URL.createObjectURL(blob)
			const a = document.createElement("a")
			a.href = url
			a.download = `accumulator-data-${Date.now()}.json`
			document.body.appendChild(a)
			a.click()
			document.body.removeChild(a)
			URL.revokeObjectURL(url)

			return a.download
		}
	}

	/**
	 * @notice Creates an async iterable over all payload data for this account
	 * @dev Iterates over all keys in storage that match account:{address}:leaf:{index}:payload
	 * @return An async iterable that yields objects with leaf index and payload
	 */
	public async *iterate(): AsyncIterable<{ index: number; payload: string }> {
		if (this.rootSnapshot) {
			for (const [index, payload] of this.rootSnapshot.payloads.entries()) yield { index, payload }
			return
		}
		const chain = await this.chain
		const generation = chain.generation
		const iterator = this.storedPayloads()

		try {
			while (true) {
				const next = await chain.read(async () => {
					if (generation !== chain.generation) throw new ChainChangedError()
					return iterator.next()
				})
				if (next.done) break
				if (generation !== chain.generation) throw new ChainChangedError()
				yield next.value
			}
		} finally {
			await iterator.return(undefined)
		}
	}

	private async *storedPayloads() {
		const prefix = `account:${this.account}:leaf:`
		for await (const { key, value } of this.storage.iterate(prefix)) {
			const match = /^(\d+):payload$/.exec(key.slice(prefix.length))
			if (match) yield { index: Number(match[1]), payload: value }
		}
	}

	/**
	 * @private
	 * @notice Notify all subscribers about a new leaf record
	 * @param leafRecord The new leaf record
	 */
	protected notifySubscribers(event: DataClientEvent): void {
		for (const subscriber of this.subscribers) {
			try {
				subscriber(event)
			} catch (error) {
				this.logger.error(`Error in subscriber: ${error}`)
			}
		}
	}

	/**
	 * @notice Groups this account's hex-encoded payloads by a substring, without a 0x prefix.
	 * @param offset The starting position in hex characters (two characters per byte).
	 * @param length The number of hex characters to use as the key.
	 * @returns A map from each substring to its matching full payloads.
	 */
	public async createIndexByPayloadSlice(offset: number, length: number): Promise<Map<string, string[]>> {
		const index = new Map<string, string[]>()
		for await (const { payload } of this.iterate()) {
			const slice = payload.slice(offset, offset + length)
			if (!index.has(slice)) index.set(slice, [])
			index.get(slice)!.push(payload)
		}
		return index
	}

	/**
	 * @notice Returns the highest contiguous leafIndex N such that all keys 'account:{address}:leaf:0' ... 'account:{address}:leaf:N' exist and have a payload.
	 * @dev This is efficient for the in-memory Map, and does not require iterating over all possible indexes if there are gaps at the end.
	 */
	private async getHighestContiguousLeafIndexWithData(): Promise<number> {
		const indexes: number[] = []
		for await (const { index, payload } of this.storedPayloads()) {
			if (payload != null) indexes.push(index)
		}
		if (indexes.length === 0) return -1
		indexes.sort((a, b) => a - b)
		// Find the highest N such that 0..N are all present
		let N = -1
		for (let i = 0; i < indexes.length; i++) {
			if (indexes[i] !== i) break
			N = i
		}
		return N
	}

	/**
	 * @notice Syncs data backwards from the latest leaf to the oldest leaf that needs syncing
	 * @dev This method attempts to resolve the current root CID via IPFS first. If that fails,
	 * it walks backwards through historical root CIDs until it finds one that can be resolved.
	 */
	private async syncBackwardsFromLatest(
		meta: AccumulatorMetadata,
		peaks: PeakWithHeight[],
		currentRootCID: CID<unknown, 113, 27, 1>
	) {
		if (meta.leafCount === 0) {
			this.logger.log(`The contract has no payloads for this account.`)
			return
		}
		const highestContiguousLeafIndexWithData = await (await this.chain).read(() => this.getHighestContiguousLeafIndexWithData())
		if (highestContiguousLeafIndexWithData >= meta.leafCount - 1) {
			this.logger.log(`All payloads are present in local storage. Verifying...`)
			return
		}
		this.logger.log(
			`Syncing backwards from leafIndex ${meta.leafCount - 1} to ${highestContiguousLeafIndexWithData + 1}`
		)
		this.logger.log(`Attempting to resolve current root CID: ${currentRootCID.toString()} via IPFS`)
		// Store the current root CID and peaks in the DB
		await this.put(
			`account:${this.account.toString()}:leafIndex:${meta.leafCount - 1}:rootCidAfterInsert`,
			currentRootCID.toString()
		)
		await this.put(
			`account:${this.account.toString()}:leafIndex:${meta.leafCount - 1}:peaksWithHeightsAfterInsert`,
			peakWithHeightArrayToStringForDB(peaks)
		)

		// Pass meta.leafCount - 1 since that's the highest leaf index (0-indexed)
		if (await this.tryResolveRootCidAndProcessPayloads(currentRootCID, meta.leafCount - 1)) {
			this.logger.log(`Loaded payloads for current root CID ${currentRootCID.toString()} via IPFS.`)
			return
		}

		// Start walking backwards though historical root CIDs
		// Track the oldest leaf for whose root CID we've attempted a resolution via IPFS
		type OldestLeaf = {
			leafIndex: number
			insertionBlockNumber: number
			peaksWithHeightsAfterInsert: PeakWithHeight[]
			leafRecord?: LeafRecord
		}

		let oldestLeafChecked: OldestLeaf = {
			leafIndex: meta.leafCount - 1,
			insertionBlockNumber: meta.previousInsertBlockNumber,
			peaksWithHeightsAfterInsert: peaks,
			leafRecord: undefined,
		}

		// Get the event log for the latest leaf.
		oldestLeafChecked.leafRecord = await this.eventCacheService.getLeafRecordForLeafIndexOrThrow(
			oldestLeafChecked.leafIndex,
			oldestLeafChecked.insertionBlockNumber
		)

		// If we're at leafIndex 0, we're finished at this point
		if (oldestLeafChecked.leafIndex === 0) {
			this.logger.log(`Loaded leafIndex 0 using accumulator contract events.`)
			return
		}

		// Otherwise we need to keep stepping back through historical root CIDs
		while (oldestLeafChecked.leafIndex > highestContiguousLeafIndexWithData) {
			// Defensive
			if (
				oldestLeafChecked.leafRecord === undefined ||
				oldestLeafChecked.leafRecord.mergeLeftHashes === undefined ||
				oldestLeafChecked.leafRecord.payload === undefined ||
				oldestLeafChecked.insertionBlockNumber === undefined
			) {
				throw new Error(`oldestLeafChecked is not fully defined: ${JSON.stringify(oldestLeafChecked)}`)
			}

			// Compute the previous root CID and peaks with heights
			const { previousRootCID, previousPeaksWithHeights } = await computePreviousRootCIDAndPeaksWithHeights(
				oldestLeafChecked.peaksWithHeightsAfterInsert,
				oldestLeafChecked.leafRecord.payload,
				oldestLeafChecked.leafRecord.mergeLeftHashes
			)

			// Check IPFS for the previous root CID
			this.logger.log(`Attempting to resolve previous root CID ${previousRootCID.toString()} via IPFS`)
			if (await this.tryResolveRootCidAndProcessPayloads(previousRootCID, meta.leafCount - 1)) {
				this.logger.log(`Loaded payloads for previous root CID ${previousRootCID.toString()} via IPFS.`)
				break
			} else {
				this.logger.log(
					`Could not resolve previous root CID ${previousRootCID.toString()} via IPFS. Walking back to older root CID.`
				)
			}

			// Otherwise prep for the next loop / step back

			// Store useful data we got
			await this.put(
				`account:${this.account}:leafIndex:${oldestLeafChecked.leafIndex - 1}:peaksWithHeightsAfterInsert`,
				peakWithHeightArrayToStringForDB(previousPeaksWithHeights)
			)
			await this.put(
				`account:${this.account}:leafIndex:${oldestLeafChecked.leafIndex - 1}:rootCidAfterInsert`,
				previousRootCID.toString()
			)

			// Guard: if we've reached leafIndex 0, stop backward sync to prevent invalid fetches
			if (oldestLeafChecked.leafIndex === 0) {
				this.logger.log(`Reached leafIndex 0 during backward sync, stopping.`)
				break
			}

			const infoForNextLoop: OldestLeaf = {
				leafIndex: oldestLeafChecked.leafIndex - 1,
				insertionBlockNumber: oldestLeafChecked.leafRecord.previousInsertBlockNumber!,
				peaksWithHeightsAfterInsert: previousPeaksWithHeights,
				leafRecord: undefined,
			}
			// fetch the previous DataAppendedToCIDAccumulator event
			// Note that this also(via the event coordinator) ensures the payload for that leaf is available in the DB
			infoForNextLoop.leafRecord = await this.eventCacheService.getLeafRecordForLeafIndexOrThrow(
				infoForNextLoop.leafIndex,
				infoForNextLoop.insertionBlockNumber
			)

			oldestLeafChecked = infoForNextLoop
		}
		// If we get here, we fully walked back to highestContiguousLeafIndexWithData and should be fully synced.
		// Perform sanity check to ensure all payloads are available
		const missing = await this.getLeafIndexesWithMissingPayload(meta.leafCount - 1)
		if (missing.length > 0) {
			throw new Error(`Missing payloads for leaf indices: ${missing.join(", ")}. This should never happen.`)
		}
	}

	private async verifyCachedPayloadCount(leafCount: number): Promise<void> {
		let payloadCount = 0
		let highestIndex = -1
		await (await this.chain).read(async () => {
			for await (const { index } of this.storedPayloads()) {
				payloadCount++
				highestIndex = Math.max(highestIndex, index)
			}
		})
		if (payloadCount !== leafCount || highestIndex !== leafCount - 1) {
			const message = `[DataClient] Cache integrity check failed for ${this.account}: expected ${leafCount} contiguous payloads starting at index 0; found ${payloadCount} payloads with highest index ${highestIndex}.`
			if (highestIndex >= leafCount) throw new CacheAheadOfSnapshotError(message)
			throw new Error(message)
		}
	}

	/** Verify the actual cached payloads, including extra entries beyond the contract's leaf count. */
	private async verifyCachedPayloads(leafCount: number, expectedRootCID: CID<unknown, 113, 27, 1>): Promise<void> {
		const errorPrefix = `[DataClient] Cache integrity check failed for ${this.account}`
		await this.verifyCachedPayloadCount(leafCount)
		// Read by index: storage iteration order and cached root metadata are not authoritative.
		const mmr = new MerkleMountainRange()
		for (let index = 0; index < leafCount; index++) {
			const payload = await (await this.chain).read(() => getLeafPayloadFromDB(this.storage, this.account, index))
			if (payload === undefined) throw new Error(`${errorPrefix}: missing leaf record at index ${index}.`)
			await mmr.addLeaf(index, payload)
		}
		const actualRootCID = await mmr.rootCID()
		if (!actualRootCID.equals(expectedRootCID)) {
			throw new Error(`${errorPrefix}: root mismatch; expected ${expectedRootCID}, got ${actualRootCID}.`)
		}
		// Polling can append leaves while the existing prefix is being hashed.
		await this.verifyCachedPayloadCount(leafCount)
	}

	/**
	 * Attempts to resolve a root CID via IPFS, stores its payloads as LeafRecords in the DB if successful,
	 * and abort any other ongoing resolution attempts.
	 *
	 * @param rootCid - The root CID to resolve
	 * @param currentLeafIndex - The highest leaf index we know about
	 * @param ipfsChecks - Array of tracked promises for other IPFS resolution attempts
	 * @returns {Promise<boolean>} - True if resolution was successful and payloads were processed
	 */
	private async tryResolveRootCidAndProcessPayloads(
		rootCid: CID<unknown, 113, 27, 1>,
		currentLeafIndex: number // meta.leafCount - 1
	): Promise<boolean> {
		try {
			// Try to resolve the CID
			const result = await this.ipfsResolver.fullyResolveCID(rootCid)

			// If we couldn't fully resolve the CID, return false
			if (!result) return false

			this.logger.log(`Successfully resolved root CID: ${rootCid.toString()}`)

			// Process and store all payloads from the iterator
			let storeCount = 0
			for await (const { leafIndex, payload } of result) {
				if (leafIndex !== undefined && payload !== undefined) {
					// Create and store the leaf record
					const leafRecord: LeafRecord = {
						account: this.account,
						leafIndex,
						payload,
					}

					await this.write(() => putLeafRecordInDB(this.storage, this.account, leafIndex, leafRecord))
					storeCount++
				}
			}

			this.logger.log(`Stored ${storeCount} payloads from IPFS`)

			// Perform sanity check to ensure all payloads are available
			const missing = await this.getLeafIndexesWithMissingPayload(currentLeafIndex)

			if (missing.length !== 0) {
				this.logger.error(
					`Unexpectedly missing payload for leaf indices: ${missing.join(", ")}. This should never happen.`
				)
				throw new Error(
					`Unexpectedly missing payload for leaf indices: ${missing.join(", ")}. This should never happen.`
				)
			}
			return true
		} catch (error: unknown) {
			// If this is an abort error, just return false
			if (error instanceof Error && error.name === "AbortError") {
				return false
			}

			// Re-throw other errors
			this.logger.error(`Error during CID resolution: ${error}`)
			throw error
		}
	}

	// Searches from leafIndex 0 to maxLeafIndex for leaves that are missing payload.
	// Returns an array of leaf indexes that are missing payload.
	// Used for sanity checking.
	private async getLeafIndexesWithMissingPayload(maxLeafIndex: number): Promise<number[]> {
		const missing: number[] = []
		for (let i = 0; i <= maxLeafIndex; i++) {
			const payload = await (await this.chain).read(() => getLeafPayloadFromDB(this.storage, this.account, i))
			if (payload === undefined) missing.push(i)
		}
		return missing
	}
}
