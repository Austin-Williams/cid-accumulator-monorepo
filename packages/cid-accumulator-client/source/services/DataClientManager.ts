import { EthereumAddress } from "../ethereum/EthereumAddress.js"
import { createLogger } from "../utils/logging.js"

import type { AccountRegistryService } from "./AccountRegistryService.js"
import type { EventCacheService } from "./EventCacheService.js"
import type { Storage } from "../storage/interface.js"
import type { LeafRecord } from "../mmr/types.js"
import type { LifecycleComponent, Logger } from "../types/common.js"
import type { AccumulatorContract } from "../ethereum/AccumulatorContract.js"
import type { IpfsResolver } from "../ipfs/IpfsResolver.js"
import type { DataClientDependencies } from "../core/dataClient/DataClient.types.js"
import { DataClient } from "../core/dataClient/DataClient.js"

/**
 * Manages a collection of DataClient instances for different accounts
 * @notice This class coordinates the creation and management of per-account dataClients
 * @dev Subscribes to both AccountRegistry and EventCoordinator to react to new accounts and LeafAppended events
 * @dev Creates DataClient instances on-demand when new accounts are detected
 * @dev Maintains a cache of DataClient instances to avoid recreating them

*/
export class DataClientManager implements LifecycleComponent {
	private dataClientDependencies: DataClientDependencies
	private dataClients: Map<string, DataClient> = new Map()
	private accountRegistryService: AccountRegistryService
	private eventCacheService: EventCacheService
	private unsubscribeFromAccountRegistryService: () => void = () => {}
	private unsubscribeFromEventCacheService: () => void = () => {}
	private initialized: boolean = false
	private isRunning: boolean = false
	private startGeneration = 0
	protected logger: Logger

	constructor(
		storage: Storage,
		accumulatorContract: AccumulatorContract,
		accountRegistryService: AccountRegistryService,
		eventCacheService: EventCacheService,
		ipfsResolver: IpfsResolver
	) {
		this.eventCacheService = eventCacheService
		this.accountRegistryService = accountRegistryService
		this.dataClientDependencies = {
			storage: storage,
			accumulatorContract: accumulatorContract,
			eventCacheService: eventCacheService,
			ipfsResolver: ipfsResolver,
		}
		this.logger = createLogger("DataClientManager")
	}

	/**
	 * Initialize the DataClientManager
	 * @notice Sets up event subscriptions for account registry and event coordinator
	 * @dev This must be called before using other methods
	 * @dev Subscribes to both new accounts and new leaf appended events
	 */
	public async init(): Promise<void> {
		if (this.initialized) {
			this.logger.log("Already initialized")
			return
		}

		this.accountRegistryService.knownAccounts.forEach((account) => {
			this.handleNewAccount(account)
		})

		// Subscribe to new accounts
		this.unsubscribeFromAccountRegistryService = this.accountRegistryService.subscribe((account) => {
			try {
				this.getOrCreateDataClient(account)
			} catch (error) {
				this.logger.error(`Error processing new account: ${error}`)
			}
		})

		// Subscribe to new LeafAppended events
		this.unsubscribeFromEventCacheService = this.eventCacheService.subscribe((event) => {
			this.onLeafAppended(event)
		})

		this.initialized = true
		this.logger.log("Initialized successfully")
	}

	public async start(): Promise<void> {
		if (this.isRunning) {
			this.logger.log("Already running")
			return
		}
		this.isRunning = true
		const generation = ++this.startGeneration

		if (!this.initialized) await this.init()
		// A retained client may have missed events while stopped. Let any older sync
		// finish first so it cannot restore the flag after we invalidate its snapshot.
		await Promise.all(
			Array.from(this.dataClients.values(), async (client) => {
				if (client.syncing) {
					try {
						await client.sync()
					} catch {
						// An earlier failure must not prevent the fresh sync below.
					}
				}
				if (this.isRunning && generation === this.startGeneration) client.completedInitialSync = false
			})
		)
		if (!this.isRunning || generation !== this.startGeneration) return

		// Start syncing in the background with error handling
		this.syncAllDataClients().catch((error) => {
			this.logger.error(`Error during background sync: ${error instanceof Error ? error.message : String(error)}`)
			// Don't rethrow - this is a background task
		})

		this.logger.log("Started - sync process running in background")
	}

	/**
	 * Stop the DataClientManager and clean up resources
	 * @notice Unsubscribes from all event sources
	 * @dev This should be called when the manager is no longer needed
	 */
	public stop(): void {
		if (!this.isRunning && !this.initialized) {
			this.logger.warn("Not initialized or running - nothing to stop")
			return
		}
		this.isRunning = false
		this.startGeneration++
		this.initialized = false
		try {
			this.unsubscribeFromAccountRegistryService()
		} finally {
			this.unsubscribeFromEventCacheService()
		}
		this.logger.log("Stopped")
	}

	/**
	 * Handles a new leaf appended event by routing it to the appropriate account dataClient
	 * @param event The leaf record containing the appended leaf data
	 * @dev This is called by the EventCoordinator subscriber when a new leaf is appended
	 * @dev Ensures the account dataClient exists before forwarding the event
	 * @dev Account address is normalized to lowercase via getOrCreateAccumulator
	 */
	private onLeafAppended(event: LeafRecord): void {
		const dataClient: DataClient = this.getOrCreateDataClient(event.account)
		try {
			dataClient.onLeafAppended(event)
		} catch (error) {
			this.logger.error(`Error processing leaf appended event: ${error}`)
		}
	}

	/**
	 * Gets an existing dataClient for the account or creates a new one if it doesn't exist
	 * @param account The account address to get or create an dataClient for
	 * @returns The DataClient instance for the specified account
	 * @dev Ensures the manager is initialized before proceeding
	 * @dev Normalizes account addresses to lowercase for consistent lookups
	 * @dev Initializes new dataClient instances before returning them
	 */
	public getOrCreateDataClient(account: EthereumAddress): DataClient {
		if (this.dataClients.has(account.toString())) return this.dataClients.get(account.toString())!
		const dataClient = new DataClient(account, this.dataClientDependencies)
		this.dataClients.set(account.toString(), dataClient)
		return dataClient
	}

	/**
	 * Returns an async iterator over all account dataClient instances
	 * @example
	 * for await (const dataClient of manager.getAllAccumulators()) {
	 *   await dataClient.sync();
	 * }
	 */
	public async *getAllDataClients(): AsyncGenerator<DataClient> {
		// Simply yield all the in-memory dataClient instances
		for (const [_account, dataClient] of this.dataClients.entries()) {
			yield dataClient
		}
	}

	/**
	 * Calls sync() on all DataClients
	 */
	public async syncAllDataClients(): Promise<void> {
		if (!this.initialized) await this.init()
		for await (const dataClient of this.getAllDataClients()) {
			if (!dataClient.completedInitialSync && !dataClient.syncing) {
				dataClient.sync().catch((error) => {
					this.logger.error(`Error syncing dataClient for account ${dataClient.account}: ${error}`)
				})
			}
		}
	}

	public handleNewAccount(account: EthereumAddress): void {
		// check if we already know about this account
		if (this.dataClients.has(account.toString())) return
		try {
			// create a new DataClient for this account (which adds it to our map)
			this.getOrCreateDataClient(account)
		} catch (error) {
			this.logger.error(`Error processing new account: ${error}`)
		}
	}
}
