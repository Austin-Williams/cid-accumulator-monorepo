import { EthereumAddress } from "../ethereum/EthereumAddress"
import { createLogger } from "../utils/logging"
import { getLeafRecordFromNormalizedLeafAppendedEvent } from "../utils/codec"
import { putLeafRecordInDB, getLeafRecordFromDB } from "../storage/utils"
import type { LeafRecord } from "../mmr/types"
import type { LifecycleComponent, Logger } from "../types/common"
import type { AccumulatorContract } from "../ethereum/AccumulatorContract"
import type { Storage } from "../storage/interface"
import type { NormalizedLeafAppendedEvent } from "../ethereum/events.types"
import type { EventCacheServiceConfig } from "./EventCacheService.types"
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

/**
 * The EventCoordinator is responsible for lazy-loading LeafAppended events from the blockchain as needed.
 * It stores any events it learns about in the local DB.
 * Before making an RPC call to check a block for LeafAppended events, it checks the local DB first.
 * If the events are already in the DB, it returns them immediately. Otherwise it makes the RPC call.
 *
 * This design is intended to minimize RPC calls for users who don't run their own nodes.
 *
 * If you don't care about minimizing RPC calls, you can use the syncEventsUpToLatestBlock() method to proactively grab all
 * LeafAppended events from the CIDAccumulatorSingleton contract's deploy block all the way up to latest.
 * (This is what the Seeder class does when its config option `lazyLoadEvents` is false.)
 *
 * It also subscribes to new LeafAppended events from the RPC provider, stores any it learns about in the DB,
 * and notifies any subscribers of any new LeafAppended events it learns about.
 */
export class EventCacheService implements LifecycleComponent {
	private accumulatorContract: AccumulatorContract
	public storage: Storage
	private lazyLoadEvents: boolean = true
	public readonly specificAccountsMode: boolean = false
	public readonly specificAccounts: EthereumAddress[]

	private singletonBirthdayBlockNum?: number
	private eventSubscribers: Array<(event: LeafRecord) => void> = []

	private isPolling: boolean = false
	private pollingIntervalMs: number
	private pollingInterval?: number | ReturnType<typeof setTimeout>
	private lastPolledBlockNum: number = 0

	private initialized: boolean = false
	private logger: Logger

	constructor(storage: Storage, accumulatorContract: AccumulatorContract, config: Required<EventCacheServiceConfig>) {
		this.storage = storage
		this.accumulatorContract = accumulatorContract
		this.logger = createLogger("EventCacheService")
		this.lazyLoadEvents = config.lazyLoadEvents
		this.pollingIntervalMs = config.pollingIntervalMs
		this.specificAccounts = config.specificAccountsOnly

		if (config.specificAccountsOnly.length > 0) this.specificAccountsMode = true
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
			// Get the contract's birthday block
			this.singletonBirthdayBlockNum = await this.accumulatorContract.getSingletonBirthdayBlockNum()
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
	 * @dev This should be called after init()
	 */
	public async start(): Promise<void> {
		// Ensure we're initialized
		if (!this.initialized) await this.init()

		// If lazyLoadEvents is false, then pre-fetch all contract events up to the latest block
		if (this.lazyLoadEvents === false) {
			this.logger.log("Syncing all historical events (lazyLoadEvents=false). This may take some time.")
			await this.syncEventsUpToLatestBlock()
			this.logger.log("Synced all historical events")
		}

		// Start polling if not already started
		if (this.isPolling) {
			this.logger.log("Already polling")
			return
		}
		this.isPolling = true
		this.logger.log("Starting polling")

		// Set up recurring polling
		this.lastPolledBlockNum = await this.accumulatorContract.getBlockNumber()
		this.pollingInterval = setInterval(() => {
			if (!this.isPolling) return

			this.pollForNewEvents().catch((error: Error) => {
				this.logger.error(`Error polling for events: ${error}`)
			})
		}, this.pollingIntervalMs)
	}

	/**
	 * Stop the event cache service
	 * @notice This will stop listening for new events from the blockchain
	 * @dev This only removes event listeners; it does not clear any cached data or subscribers
	 */
	public stop(): void {
		if (!this.isPolling) return
		this.isPolling = false
		this.logger.log("Stopped")
		// Clear the polling interval
		if (this.pollingInterval) {
			clearInterval(this.pollingInterval)
			this.pollingInterval = undefined
		}
	}

	// PRIMARY METHODS

	/**
	 * Poll for new events from the blockchain
	 * @dev This is called periodically by the polling interval
	 * @private
	 */
	private async pollForNewEvents(): Promise<void> {
		try {
			// Get the current block number
			const currentBlock = await this.accumulatorContract.getBlockNumber()

			// If we're already at the latest block, nothing to do
			if (currentBlock <= this.lastPolledBlockNum) return

			// Process blocks in batches to avoid overwhelming the RPC
			const batchSize = 10
			for (let startBlock = this.lastPolledBlockNum + 1; startBlock <= currentBlock; startBlock += batchSize) {
				// If we're no longer running, exit early
				if (!this.isPolling) return

				const endBlock = Math.min(startBlock + batchSize - 1, currentBlock)

				// Get events for this batch
				const events: NormalizedLeafAppendedEvent[] = await this.accumulatorContract.getLeafAppendedLogs(
					startBlock,
					endBlock,
					this.specificAccountsMode ? this.specificAccounts : undefined
				)

				// Group events by block
				const blockToEvents = new Map<number, NormalizedLeafAppendedEvent[]>()
				for (const event of events) {
					if (!blockToEvents.has(event.blockNumber)) {
						blockToEvents.set(event.blockNumber, [])
					}
					blockToEvents.get(event.blockNumber)!.push(event)
					this.logger.log(
						`Account ${event.account} has a new leaf with index ${event.leafIndex} in block ${event.blockNumber}`
					)
				}

				// Process each block
				for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
					const blockEvents = blockToEvents.get(blockNum) || []
					await this.processEventsForBlock(blockNum, blockEvents)

					// Update the last processed block
					this.lastPolledBlockNum = blockNum
					await this.storage.put("events:latestPolledBlock", blockNum.toString())
				}
			}

			this.logger.log(`Processed events up to block ${this.lastPolledBlockNum}`)
		} catch (error) {
			this.logger.error(`Error polling for events: ${error}`)
		}
	}

	/**
	 * Retrieves all leaf appended events for a specific account within a block range, and returns the relevant information about each event.
	 * @notice This method will fetch events from the blockchain if they are not already in the local database
	 * @param account The account address to get events for
	 * @param fromBlock The starting block number (inclusive)
	 * @param toBlock The ending block number (inclusive)
	 * @returns Array of LeafRecord objects containing event data
	 */
	public async getLeafRecordsForAccount(
		account: EthereumAddress,
		fromBlock: number,
		toBlock: number
	): Promise<LeafRecord[]> {
		if (!this.initialized) await this.init()

		// Get leaf records from DB
		const leafRecords: LeafRecord[] = []

		// Iterate through blocks in the range
		for (let blockNum = fromBlock; blockNum <= toBlock; blockNum++) {
			const blockAccountsKey = `events:block:${blockNum}`
			let blockAccounts = await this.storage.get(blockAccountsKey)
			if (!blockAccounts) {
				await this.fetchAndStoreEventsForBlock(blockNum)
				blockAccounts = await this.storage.get(blockAccountsKey)
			}

			const accountLeafIndicesKey = `events:account:${account.toString()}:block:${blockNum}`
			const accountLeafIndicesStr = await this.storage.get(accountLeafIndicesKey)
			if (accountLeafIndicesStr) {
				try {
					const leafIndices = JSON.parse(accountLeafIndicesStr) as number[]
					for (const leafIndex of leafIndices) {
						const leafRecord = await getLeafRecordFromDB(this.storage, account, leafIndex)
						if (leafRecord) leafRecords.push(leafRecord)
					}
				} catch (e) {
					throw new Error(`Failed to parse events for account ${account.toString()} at block ${blockNum}: ${e}`)
				}
			}
		}

		return leafRecords
	}

	/**
	 * Retrieves a specific leaf appended event for an account and leaf index at a given block, and returns the relevant information about the event.
	 * This function isn't called unless the caller knows the event to be in this block.
	 * @notice This method will fetch the event from the blockchain if it is not already in the local database, and throw an error if it is not found.
	 * @param account The account address to get the event for
	 * @param leafIndex The specific leaf index to retrieve
	 * @param blockNum The block number where the event occurred
	 * @returns The LeafRecord object if found
	 */
	public async getLeafRecordForLeafIndexOrThrow(
		account: EthereumAddress,
		leafIndex: number,
		blockNum: number
	): Promise<LeafRecord> {
		let leafRecords = await this.getLeafRecordsForAccount(account, blockNum, blockNum)
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
	public async syncEventsUpToLatestBlock(batchSize: number = 500): Promise<void> {
		if (!this.initialized) await this.init()

		// Get latest block
		const latestBlockStr = await this.accumulatorContract.getBlockNumber()
		if (!latestBlockStr) throw new Error("[EventCoordinator] Cannot get latest block number")
		const latestBlock = Number(latestBlockStr)

		// Determine which blocks from birthdayBlock to latestBlock need to be fetched
		const blocksToFetch = []
		for (let blockNum = this.singletonBirthdayBlockNum!; blockNum <= latestBlock; blockNum++) {
			const blockEventsKey = `events:block:${blockNum}`
			const existingEvents = await this.storage.get(blockEventsKey)
			if (!existingEvents) {
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
			// If specificAccounts is defined, filter events only for those accounts
			const events: NormalizedLeafAppendedEvent[] = await this.accumulatorContract.getLeafAppendedLogs(
				startBlock,
				endBlock,
				this.specificAccountsMode ? this.specificAccounts : undefined
			)

			// Process events by block
			const blockToEvents = new Map<number, NormalizedLeafAppendedEvent[]>()

			// Group events by block number
			for (const event of events) {
				const blockNumber = Number(event.blockNumber)
				if (!blockToEvents.has(blockNumber)) {
					blockToEvents.set(blockNumber, [])
				}
				blockToEvents.get(blockNumber)!.push(event)
			}

			// Process each block's events
			for (let blockNum = startBlock; blockNum <= endBlock; blockNum++) {
				// Check if we've already processed this block
				const blockEventsKey = `events:block:${blockNum}`
				const existingEvents = await this.storage.get(blockEventsKey)

				if (!existingEvents) {
					const blockEvents = blockToEvents.get(blockNum) || []

					// Process blocks with no events
					if (blockEvents.length === 0) {
						await this.storage.put(blockEventsKey, JSON.stringify([]))
					} else {
						// Process blocks with events
						await this.processEventsForBlock(blockNum, blockEvents)
					}
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
	 * @param options.forAccount If provided, only clears events for this specific account
	 * @returns The number of entries deleted from the database
	 */
	public async clearEventCache(options?: {
		beforeBlock?: number
		afterBlock?: number
		forAccount?: string
	}): Promise<number> {
		if (!this.initialized) await this.init()

		let deletedCount = 0
		const keysToDelete: string[] = []

		// Normalize account if provided
		const normalizedAccount = options?.forAccount ? options.forAccount.toLowerCase() : undefined

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

			// Apply account filter if specified
			if (normalizedAccount && !key.includes(`account:${normalizedAccount}:`)) {
				// For block-level keys, we need to check if the account is in the list
				if (key.startsWith("events:block:")) {
					const accountsStr = await this.storage.get(key)
					if (accountsStr) {
						try {
							const accounts = JSON.parse(accountsStr) as string[]
							// Only delete if this account is the only one in the list
							if (accounts.length !== 1 || accounts[0] !== normalizedAccount) {
								shouldDelete = false
							}
						} catch (e) {
							this.logger.error(`Error parsing accounts for ${key}: ${e}`)
							shouldDelete = false
						}
					}
				} else if (!key.includes(`account:${normalizedAccount}:`)) {
					shouldDelete = false
				}
			}

			if (shouldDelete) {
				keysToDelete.push(key)
			}
		}

		// Delete all marked keys
		for (const key of keysToDelete) {
			await this.storage.delete(key)
			deletedCount++
		}

		this.logger.log(`Cleared ${deletedCount} event cache entries`)
		return deletedCount
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

		// Check if we already have events for this block
		const blockEventsKey = `events:block:${blockNumber}`
		const existingEvents = await this.storage.get(blockEventsKey)

		if (existingEvents && !forceRefresh) {
			// Already have events for this block and not forcing a refresh
			return
		}

		if (forceRefresh && existingEvents) {
			this.logger.log(`Force refreshing events for block ${blockNumber}`)
		}

		// Fetch events from blockchain
		// If specificAccounts is defined, filter events only for those accounts
		const events: NormalizedLeafAppendedEvent[] = await this.accumulatorContract.getLeafAppendedLogs(
			blockNumber,
			blockNumber,
			this.specificAccounts ? this.specificAccounts : undefined
		)
		if (events.length === 0) {
			// No events in this block, but mark it as processed
			await this.storage.put(blockEventsKey, JSON.stringify([]))
			return
		}

		// Process the events for this block
		await this.processEventsForBlock(blockNumber, events)
		return
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

	/**
	 * Stores a leaf record in the database using the standard schema
	 * @param event The normalized leaf appended event to store
	 * @dev This method normalizes the account address to lowercase and converts the event to a LeafRecord
	 * @dev Uses putLeafRecordInDB from storageHelpers to ensure consistent storage format
	 */
	private async storeLeafRecord(event: NormalizedLeafAppendedEvent): Promise<void> {
		const leafRecord = getLeafRecordFromNormalizedLeafAppendedEvent(event)

		await putLeafRecordInDB(this.storage, event.account, event.leafIndex, leafRecord)
	}

	/**
	 * Processes a batch of events for a specific block and stores them in the database
	 *
	 * @param blockNumber The block number being processed
	 * @param events Array of events from the block
	 */
	private async processEventsForBlock(blockNumber: number, events: NormalizedLeafAppendedEvent[]): Promise<void> {
		// First store each leaf record
		for (const event of events) {
			// Store the leaf record in the accounts section of the DB (for use by all other classes)
			await this.storeLeafRecord(event)
		}

		// Group events by account
		const eventsByAccount = new Map<string, number[]>()
		for (const event of events) {
			const account = event.account.toString()
			if (!eventsByAccount.has(account)) {
				eventsByAccount.set(account, [])
			}
			eventsByAccount.get(account)!.push(event.leafIndex)
		}

		// Store events by account (for use by EventCoordinator)
		for (const [account, leafIndices] of eventsByAccount.entries()) {
			const accountEventsKey = `events:account:${account}:block:${blockNumber}`
			await this.storage.put(accountEventsKey, JSON.stringify(leafIndices))
		}

		// Mark block as processed (for use by EventCoordinator)
		await this.storage.put(`events:block:${blockNumber}`, JSON.stringify(Array.from(eventsByAccount.keys())))

		// Notify subscribers
		for (const event of events) {
			this.notifySubscribers(getLeafRecordFromNormalizedLeafAppendedEvent(event))
		}
	}
}

// HELPERS

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
