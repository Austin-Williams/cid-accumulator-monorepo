import { getChainState, type ChainState, type ChainSnapshotWithFinality } from "./ChainState.js"
import { createLogger } from "../utils/logging.js"
import { getLeafRecordFromNormalizedDataAppendedEvent } from "../utils/codec.js"
import { putLeafRecordInDB, getLeafRecordFromDB } from "../storage/utils.js"
import type { LeafRecord } from "../mmr/types.js"
import type { LifecycleComponent, Logger } from "../types/common.js"
import type { AccumulatorContract } from "../ethereum/AccumulatorContract.js"
import type { Storage } from "../storage/interface.js"
import type { NormalizedDataAppendedEvent } from "../ethereum/events.types.js"
import type { EventCacheServiceConfig } from "./EventCacheService.types.js"

const FINALIZED_BATCH_SIZE = 500
const LIVE_BATCH_SIZE = 10

/** Caches and follows events emitted by one configured accumulator contract. */
export class EventCacheService implements LifecycleComponent {
	private get chain(): Promise<ChainState> { return getChainState(this.storage, this.accumulatorContract) }
	private chainGeneration = -1
	private accumulatorContract: AccumulatorContract
	public storage: Storage
	private lazyLoadEvents: boolean = true

	private eventSubscribers: Array<(event: LeafRecord) => void> = []

	private isPolling: boolean = false
	private pollingIntervalMs: number
	private pollingInterval?: number | ReturnType<typeof setTimeout>
	private lastPolledBlockNum: number = 0
	private hasPollingCursor = false
	private announcedEvents = new Map<number, Set<string>>()
	private pollingGeneration = 0

	private initialized: boolean = false
	private logger: Logger

	constructor(storage: Storage, accumulatorContract: AccumulatorContract, config: Required<EventCacheServiceConfig>) {
		this.storage = storage
		this.accumulatorContract = accumulatorContract
		this.logger = createLogger("EventCacheService")
		this.lazyLoadEvents = config.lazyLoadEvents
		this.pollingIntervalMs = config.pollingIntervalMs
	}

	/**
	 * Initialize the EventCacheService
	 * This checks for required configuration and prepares the service for use
	 */
	public async init(): Promise<void> {
		if (this.initialized) {
			this.logger.warn("Already initialized. Skipping initialization.")
			return
		}
		try {
			this.logger.log("Initializing...")
			this.initialized = true
			this.logger.log("Initialized successfully")
		} catch (error) {
			this.logger.error(`Error during initialization: ${error}`)
			throw error
		}
	}

	/**
	 * Start the event cache service
	 * @notice This will start listening for new events from the blockchain
	 * @dev Resumes the saved polling cursor and catches up before scheduling new polls.
	 */
	public async start(): Promise<void> {
		if (this.isPolling) {
			this.logger.log("Already polling")
			return
		}
		this.isPolling = true
		const generation = ++this.pollingGeneration
		try {
			if (!this.initialized) await this.init()
			if (!this.isCurrentPoll(generation)) return
			const chain = await this.chain
			const snapshot = await chain.snapshot()
			const currentBlock = snapshot.block.number
			if (!this.isCurrentPoll(generation)) return
			await chain.commit(snapshot, async () => {
				const savedCursor = await this.storage.get("events:latestPolledBlock")
				if (!this.isCurrentPoll(generation)) return
				if (savedCursor === undefined) {
					// Keep the first lazy start at the head, but make even a stop before the first tick resumable.
					await this.storage.put("events:latestPolledBlock", currentBlock.toString())
					if (!this.isCurrentPoll(generation)) return
					this.setPollingCursor(currentBlock)
				} else {
					const cursor = Number(savedCursor)
					if (!/^\d+$/.test(savedCursor) || !Number.isSafeInteger(cursor)) {
						throw new Error(`[EventCacheService] Invalid saved polling cursor: ${savedCursor}`)
					}
					// Another service sharing storage may have advanced farther than this one's subscribers.
					this.setPollingCursor(this.hasPollingCursor ? Math.min(this.lastPolledBlockNum, cursor) : cursor)
				}
			})

			if (this.lazyLoadEvents === false) {
				this.logger.log("Syncing all historical events (lazyLoadEvents=false). This may take some time.")
				await this.syncEventsUpToLatestBlock()
				this.logger.log("Synced all historical events")
			}
			if (!this.isCurrentPoll(generation)) return

			// Catch up before downstream services begin pinning the restarted clients.
			await this.pollForNewEvents(currentBlock, generation)
			if (!this.isCurrentPoll(generation)) return
			this.logger.log("Starting polling")
			let activePoll: Promise<void> | undefined
			this.pollingInterval = setInterval(() => {
				if (!this.isCurrentPoll(generation)) return
				activePoll ??= this.pollForNewEvents(undefined, generation)
					.catch((error: Error) => this.logger.error(`Error polling for events: ${error}`))
					.finally(() => { activePoll = undefined })
				return activePoll
			}, this.pollingIntervalMs)
		} catch (error) {
			if (generation === this.pollingGeneration) this.isPolling = false
			throw error
		}
	}

	/**
	 * Stop the event cache service
	 * @notice This will stop listening for new events from the blockchain
	 * @dev This only removes event listeners; it does not clear any cached data or subscribers
	 */
	public stop(): void {
		if (!this.isPolling) return
		this.isPolling = false
		this.pollingGeneration++
		this.logger.log("Stopped")
		// Clear the polling interval
		if (this.pollingInterval) {
			clearInterval(this.pollingInterval)
			this.pollingInterval = undefined
		}
	}

	// PRIMARY METHODS

	private isCurrentPoll(generation: number): boolean {
		return this.isPolling && generation === this.pollingGeneration
	}

	private setPollingCursor(blockNumber: number): void {
		this.lastPolledBlockNum = blockNumber
		this.hasPollingCursor = true
		for (const announcedBlock of this.announcedEvents.keys()) {
			if (announcedBlock <= blockNumber) this.announcedEvents.delete(announcedBlock)
		}
	}

	private async isBlockCached(blockNumber: number): Promise<boolean> {
		return (await this.storage.get(`events:account:${this.accumulatorContract.address}:block:${blockNumber}`)) !== undefined
	}

	/**
	 * Poll for new events from the blockchain
	 * @dev This is called periodically by the polling interval
	 * @private
	 */
	private async pollForNewEvents(currentBlock?: number, generation = this.pollingGeneration): Promise<void> {
		const chain = await this.chain
		const snapshot = await chain.snapshot()
		if (!this.isCurrentPoll(generation)) return
		const savedCursor = await chain.read(() => this.storage.get("events:latestPolledBlock"))
		if (savedCursor !== undefined && Number(savedCursor) < this.lastPolledBlockNum) {
			this.setPollingCursor(Number(savedCursor))
			this.announcedEvents.clear()
		}
		if (snapshot.generation !== this.chainGeneration) {
			this.announcedEvents.clear()
			this.chainGeneration = snapshot.generation
			if (savedCursor !== undefined) this.setPollingCursor(Math.min(this.lastPolledBlockNum, Number(savedCursor)))
		}
		currentBlock = Math.min(currentBlock ?? snapshot.block.number, snapshot.block.number)
		let finalizedBatchSize = FINALIZED_BATCH_SIZE
		let startBlock = this.lastPolledBlockNum + 1
		while (startBlock <= currentBlock && this.isCurrentPoll(generation)) {
			const endBlock = startBlock <= snapshot.finalizedBlockNumber
				? Math.min(startBlock + finalizedBatchSize - 1, snapshot.finalizedBlockNumber, currentBlock)
				: Math.min(startBlock + LIVE_BATCH_SIZE - 1, currentBlock)
			let events: NormalizedDataAppendedEvent[]
			try {
				events = await this.fetchRange(startBlock, endBlock, snapshot)
			} catch (error) {
				// Some RPC providers only accept small log ranges. Retry the same cursor.
				if (endBlock - startBlock + 1 <= LIVE_BATCH_SIZE) throw error
				finalizedBatchSize = LIVE_BATCH_SIZE
				continue
			}
			const eventsByBlock = groupEventsByBlock(events)
			await chain.ensureCanonical(snapshot)
			await chain.commit(snapshot, async () => {
				for (let block = startBlock; block <= endBlock; block++) {
					if (!this.isCurrentPoll(generation)) return
					await this.processEventsForBlock(block, eventsByBlock.get(block) ?? [])
					await this.storage.put("events:latestPolledBlock", String(block))
					this.lastPolledBlockNum = block
					this.announcedEvents.delete(block)
				}
			})
			startBlock = endBlock + 1
		}
	}

	private async fetchRange(from: number, to: number, snapshot: ChainSnapshotWithFinality): Promise<NormalizedDataAppendedEvent[]> {
		const chain = await this.chain
		const events: NormalizedDataAppendedEvent[] = []
		const historicalEnd = Math.min(to, snapshot.finalizedBlockNumber, snapshot.block.number)
		if (from <= historicalEnd) events.push(...await this.accumulatorContract.getDataAppendedLogs(from, historicalEnd))
		for (let number = Math.max(from, historicalEnd + 1); number <= to; number++) {
			const block = await chain.getBlock(snapshot, number)
			events.push(...await this.accumulatorContract.getDataAppendedLogs(number, number, block.hash))
		}
		return events
	}

	/**
	 * Retrieves all leaf appended events for a specific account within a block range, and returns the relevant information about each event.
	 * @notice This method will fetch events from the blockchain if they are not already in the local database
	 * @param fromBlock The starting block number (inclusive)
	 * @param toBlock The ending block number (inclusive)
	 * @returns Array of LeafRecord objects containing event data
	 */
	public async getLeafRecords(
		fromBlock: number,
		toBlock: number
	): Promise<LeafRecord[]> {
		if (!this.initialized) await this.init()
		const chain = await this.chain
		const snapshot = await chain.snapshot()

		const account = this.accumulatorContract.address
		const leafRecords: LeafRecord[] = []

		// Iterate through blocks in the range
		for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
			if (!(await this.isBlockCached(blockNum))) {
				await this.fetchEventsForBlock(blockNum)
			}

			const accountLeafIndicesKey = `events:account:${account.toString()}:block:${blockNum}`
			const accountLeafIndicesStr = await (await this.chain).read(() => this.storage.get(accountLeafIndicesKey))
			if (accountLeafIndicesStr) {
				try {
					const leafIndices = JSON.parse(accountLeafIndicesStr) as number[]
					for (const leafIndex of leafIndices) {
						const leafRecord = await (await this.chain).read(() => getLeafRecordFromDB(this.storage, account, leafIndex))
						if (leafRecord) leafRecords.push(leafRecord)
					}
				} catch (e) {
					throw new Error(`Failed to parse events for account ${account.toString()} at block ${blockNum}: ${e}`)
				}
			}
		}

		await chain.ensureCanonical(snapshot)
		return leafRecords
	}

	/**
	 * Retrieves a specific leaf appended event for an account and leaf index at a given block, and returns the relevant information about the event.
	 * This function isn't called unless the caller knows the event to be in this block.
	 * @notice This method will fetch the event from the blockchain if it is not already in the local database, and throw an error if it is not found.
	 * @param leafIndex The specific leaf index to retrieve
	 * @param blockNum The block number where the event occurred
	 * @returns The LeafRecord object if found
	 */
	public async getLeafRecordForLeafIndexOrThrow(
		leafIndex: number,
		blockNum: number
	): Promise<LeafRecord> {
		const account = this.accumulatorContract.address
		let leafRecords = await this.getLeafRecords(blockNum, blockNum)
		let leafRecordsWithLeafIndex = leafRecords.filter((e) => e.leafIndex === leafIndex)

		if (leafRecordsWithLeafIndex.length > 1) {
			throw new Error(
				"[EventCoordinator] Multiple events found with same leafIndex for same account. This should never happen."
			)
		}

		// If no event is found throw an error
		if (leafRecordsWithLeafIndex.length === 0)
			throw new Error(
				`[EventCoordinator] No events found with leafIndex=${leafIndex} for account ${account.toString()} at block ${blockNum}.`
			)

		return leafRecordsWithLeafIndex[0]
	}

	/**
	 * Synchronizes events from the latest processed block up to the current block, using batching
	 * to reduce the number of RPC calls
	 *
	 * @notice This is a convenience function for having the EventCoordinator cache all events from the birthday block up to the latest block.
	 * @dev This DOES NOT have to be called for proper functioning of the EventCoordinator.
	 * 	The EventCoordinator will lazy-load events from the blockchain as need.
	 * 	This is a convenience function for having the EventCoordinator cache all events up to the latest block.
	 * 	After this completes, all classes that use the EventCacheService will have cache hits for all events from the birthday block up to the latest block.
	 * 	If you are using a free-tier RPC provider, be sure to set a low batchSize and conservative rateLimitter values
	 * 	to avoid hitting rate limits.
	 * @param batchSize Number of blocks to process in each batch (default: 500)
	 */
	public async syncEventsUpToLatestBlock(batchSize: number = FINALIZED_BATCH_SIZE): Promise<void> {
		if (!this.initialized) await this.init()

		// Get latest block
		const chain = await this.chain
		const snapshot = await chain.snapshot()
		const latestBlock = snapshot.block.number
		const state = await this.accumulatorContract.getCIDAccumulatorState({ blockHash: snapshot.block.hash, requireCanonical: true })
		await chain.ensureCanonical(snapshot)
		// An empty accumulator has no history; forward polling still catches its first append.
		if (state.meta.leafCount === 0) return
		const birthdayBlockNum = state.meta.deployBlockNumber

		// Determine which blocks from birthdayBlock to latestBlock need to be fetched
		const blocksToFetch = []
		for (let blockNum = birthdayBlockNum; blockNum <= latestBlock; blockNum++) {
			if (!(await this.isBlockCached(blockNum))) {
				blocksToFetch.push(blockNum)
			}
		}

		// Partition blocksToFetch into contiguous batches of size at most batchSize
		const batches = partitionBlocksIntoContiguousBatches(blocksToFetch, batchSize)

		// Process in batches
		for (const batch of batches) {
			const { startBlock, endBlock } = batch
			this.logger.log(`Processing blocks ${startBlock} to ${endBlock} (batch of ${endBlock - startBlock + 1} blocks)`)

			// Fetch events for the entire batch at once
			const events = await this.fetchRange(startBlock, endBlock, snapshot)
			await chain.ensureCanonical(snapshot)

			const blockToEvents = groupEventsByBlock(events)

			// Process each block's events
			for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
				if (!(await this.isBlockCached(blockNum))) {
					const blockEvents = blockToEvents.get(blockNum) || []
					await chain.commit(snapshot, () => this.processEventsForBlock(blockNum, blockEvents))
				}
			}
		}
	}

	/**
	 * Clears the local event cache to reduce database size
	 * @notice This removes all entries with keys starting with "events:" from the database
	 * @dev This will cause the EventCoordinator to re-fetch events from the blockchain when needed
	 * @dev This does NOT delete the actual leaf data (account:{address}:leaf:{leafIndex}), only the event indices
	 * @param options Optional parameters
	 * @param options.beforeBlock If provided, only clears events before this block number
	 * @param options.afterBlock If provided, only clears events after this block number
	 * @returns The number of entries deleted from the database
	 */
	public async clearEventCache(options?: {
		beforeBlock?: number
		afterBlock?: number
	}): Promise<number> {
		if (!this.initialized) await this.init()

		return (await this.chain).read(async () => {
			let deletedCount = 0
			const keysToDelete: string[] = []

			// Iterate through all keys in the database
			for await (const { key } of this.storage.iterate("events:")) {
				let shouldDelete = true

				// Apply block number filter if specified
				if (options?.beforeBlock !== undefined || options?.afterBlock !== undefined) {
					// Extract block number from key
					const blockMatch = key.match(/:block:(\d+)$/)
					if (blockMatch) {
						const blockNum = parseInt(blockMatch[1], 10)

						// Skip if block is not before the specified block
						if (options?.beforeBlock !== undefined && blockNum >= options.beforeBlock) {
							shouldDelete = false
						}

						// Skip if block is not after the specified block
						if (options?.afterBlock !== undefined && blockNum <= options.afterBlock) {
							shouldDelete = false
						}
					}
				}

				if (shouldDelete) {
					keysToDelete.push(key)
				}
			}

			for (const key of keysToDelete) {
				await this.storage.delete(key)
				deletedCount++
			}

			this.logger.log(`Cleared ${deletedCount} event cache entries`)
			return deletedCount
		})
	}

	/**
	 * Subscribe to leaf appended events
	 * @param subscriber Function that will be called when new events are found
	 * @returns Function to unsubscribe
	 */
	public subscribe(subscriber: (newLeafRecord: LeafRecord) => void): () => void {
		this.eventSubscribers.push(subscriber)

		// Return unsubscribe function
		return () => {
			const index = this.eventSubscribers.indexOf(subscriber)
			if (index !== -1) {
				this.eventSubscribers.splice(index, 1)
			}
		}
	}

	/**
	 * Fetches and stores events for a single block
	 * @param blockNumber The block number to fetch events for
	 * @param forceRefresh If true, will refetch events even if they're already in the database
	 * @returns The number of events fetched and stored
	 */
	public async fetchAndStoreEventsForBlock(blockNumber: number, forceRefresh: boolean = false): Promise<void> {
		if (!this.initialized) await this.init()
		await this.fetchEventsForBlock(blockNumber, forceRefresh)
	}

	private async fetchEventsForBlock(
		blockNumber: number,
		forceRefresh: boolean = false
	): Promise<void> {
		const chain = await this.chain
		const snapshot = await chain.snapshot()
		if (snapshot.generation !== this.chainGeneration) {
			this.announcedEvents.clear()
			this.chainGeneration = snapshot.generation
		}
		if (!forceRefresh && await chain.read(() => this.isBlockCached(blockNumber))) return
		const events = await this.fetchRange(blockNumber, blockNumber, snapshot)
		await chain.ensureCanonical(snapshot)
		await chain.commit(snapshot, () => this.processEventsForBlock(blockNumber, events))
	}

	// PRIVATE METHODS

	/**
	 * Notify all subscribers about a new event
	 * @param event The normalized event to send to subscribers
	 */
	private notifySubscribers(newLeafRecord: LeafRecord): void {
		for (const subscriber of this.eventSubscribers) {
			try {
				subscriber(newLeafRecord)
			} catch (error) {
				this.logger.error(`Error in new leaf record subscriber: ${error}`)
			}
		}
	}

	private announceEventsForBlock(blockNumber: number, events: NormalizedDataAppendedEvent[]): void {
		// A lazy fetch may publish events before polling reaches this block.
		let announced = this.announcedEvents.get(blockNumber)
		if (!announced && blockNumber > this.lastPolledBlockNum && events.length > 0) {
			announced = new Set<string>()
			this.announcedEvents.set(blockNumber, announced)
		}
		for (const event of events) {
			const eventKey = `${event.account}:${event.leafIndex}`
			if (announced?.has(eventKey)) continue
			announced?.add(eventKey)
			this.notifySubscribers(getLeafRecordFromNormalizedDataAppendedEvent(event))
		}
	}

	/**
	 * Stores a leaf record in the database using the standard schema
	 * @param event The normalized leaf appended event to store
	 * @dev This method normalizes the account address to lowercase and converts the event to a LeafRecord
	 * @dev Uses putLeafRecordInDB from storageHelpers to ensure consistent storage format
	 */
	private async storeLeafRecord(event: NormalizedDataAppendedEvent): Promise<void> {
		const leafRecord = getLeafRecordFromNormalizedDataAppendedEvent(event)

		await (await this.chain).trackAccount(event.account, event.leafIndex + 1, event.blockNumber)
		await putLeafRecordInDB(this.storage, event.account, event.leafIndex, leafRecord)
	}

	/** Publish block coverage only after every event's leaf data has been stored. */
	private async processEventsForBlock(blockNumber: number, events: NormalizedDataAppendedEvent[]): Promise<void> {
		for (const event of events) await this.storeLeafRecord(event)
		await this.storage.put(
			`events:account:${this.accumulatorContract.address}:block:${blockNumber}`,
			JSON.stringify(events.map(event => event.leafIndex))
		)
		this.announceEventsForBlock(blockNumber, events)
	}
}

// HELPERS

function groupEventsByBlock(events: NormalizedDataAppendedEvent[]): Map<number, NormalizedDataAppendedEvent[]> {
	const byBlock = new Map<number, NormalizedDataAppendedEvent[]>()
	for (const event of events) {
		const records = byBlock.get(event.blockNumber)
		if (records) records.push(event)
		else byBlock.set(event.blockNumber, [event])
	}
	return byBlock
}

/**
 * Interface defining a contiguous batch of blocks
 */
interface BlockBatch {
	startBlock: number
	endBlock: number
}

/**
 * Partitions a list of block numbers into contiguous batches of limited size
 * @param blocks Array of block numbers to partition
 * @param maxBatchSize Maximum size of each batch
 * @returns Array of contiguous block batches
 */
function partitionBlocksIntoContiguousBatches(blocks: number[], maxBatchSize: number): BlockBatch[] {
	const batches: BlockBatch[] = []

	if (blocks.length === 0) {
		return batches
	}

	// Sort the blocks to ensure they're in ascending order
	blocks.sort((a, b) => a - b)

	let currentStart = blocks[0]
	let previousBlock = blocks[0]
	let currentLength = 1

	// Group contiguous blocks together
	for (let i = 1; i < blocks.length; i++) {
		const currentBlock = blocks[i]

		// If this block is contiguous with the previous one and we haven't hit batch size limit
		if (currentBlock === previousBlock + 1 && currentLength < maxBatchSize) {
			// Continue the current batch
			previousBlock = currentBlock
			currentLength++
		} else {
			// End the current batch and start a new one
			batches.push({
				startBlock: currentStart,
				endBlock: previousBlock,
			})

			// Start a new batch
			currentStart = currentBlock
			previousBlock = currentBlock
			currentLength = 1
		}
	}

	// Add the final batch
	if (currentLength > 0) {
		batches.push({
			startBlock: currentStart,
			endBlock: previousBlock,
		})
	}

	return batches
}
