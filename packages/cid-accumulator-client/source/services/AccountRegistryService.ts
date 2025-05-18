import { EthereumAddress } from "../ethereum/EthereumAddress"
import { createLogger } from "../utils/logging"
import type { AccountRegistryServiceConfig } from "./AccountRegistryService.types"
import type { Logger } from "../types/common"
import type { AccumulatorContract } from "../ethereum/AccumulatorContract"
import type { Storage } from "../storage/interface"
import type { LifecycleComponent } from "../types/common"
import type { NormalizedNewAccountInitializedEvent } from "../ethereum/events.types"

/**
 * DB Schema:
 * account-registry:singletonBirthdayBlock: <blockNumber>
 * account-registry:lastProcessedBlock: <blockNumber>
 * account-registry:account:<index>: <accountAddress>
 */

/**
 * This AccountRegistryService is responsible for tracking all accounts that have ever appended a leaf to the singleton.
 *
 * When an address appends payload data to the CIDAccumulatorSingleton contract for the first time,
 * the contract emits a NewAccountInitialized event. This service finds those events, stores the accounts in the DB,
 * and notifies any subscribers.
 *
 * It also monitors for new accounts and alerts any subscribers.
 */
export class AccountRegistryService implements LifecycleComponent {
	public knownAccounts: EthereumAddress[] = []
	public initialized: boolean = false
	public pollForNewAccounts: boolean = false
	public readonly pollingIntervalMs: number
	public readonly specificAccountsMode: boolean = false

	private accumulatorContract: AccumulatorContract
	private storage: Storage
	private batchSize: number
	private subscribers: ((account: EthereumAddress) => void)[] = []
	private logger: Logger

	constructor(
		storage: Storage,
		accumulatorContract: AccumulatorContract,
		config: Required<AccountRegistryServiceConfig>
	) {
		this.storage = storage
		this.accumulatorContract = accumulatorContract
		this.knownAccounts = config.specificAccountsOnly
		this.pollingIntervalMs = config.pollingIntervalMs
		this.batchSize = config.batchSize
		this.logger = createLogger("AccountRegistry")
		if (config.specificAccountsOnly.length > 0) this.specificAccountsMode = true
	}

	public async init() {
		try {
			// Get singleton birthday block
			let singletonBirthdayBlock: string | undefined = await this.storage.get("account-registry:singletonBirthdayBlock")
			if (!singletonBirthdayBlock) {
				singletonBirthdayBlock = (await this.accumulatorContract.getSingletonBirthdayBlockNum()).toString()
				if (!singletonBirthdayBlock) throw new Error("Failed to get singleton birthday block")
				await this.storage.put("account-registry:singletonBirthdayBlock", singletonBirthdayBlock)
			}

			if (!this.specificAccountsMode) {
				// Get highest processed block
				const lastProcessedBlock = await this.storage.get("account-registry:lastProcessedBlock")
				if (!lastProcessedBlock) {
					await this.storage.put("account-registry:lastProcessedBlock", singletonBirthdayBlock)
				}

				// Get all known accounts from DB
				for await (const record of this.storage.iterate("account-registry:account:")) {
					this.knownAccounts.push(EthereumAddress.fromString(record.value))
				}
			}
			this.initialized = true

			this.logger.log(`Initialized with ${this.knownAccounts.length} accounts`)
		} catch (error) {
			this.logger.error(`Error during initialization: ${error}`)
			throw error
		}
	}

	public async start() {
		if (!this.initialized) await this.init()
		// Notify subscribers of all known accounts
		for (const account of this.knownAccounts) {
			this.notifySubscribers(account)
		}

		if (this.specificAccountsMode) return

		// Set flag before starting the polling loop to avoid race conditions
		this.pollForNewAccounts = true
		// fire and forget
		this.poll().catch((error) => {
			this.logger.error(`Error in polling loop: ${error}`)
		})
	}

	public stop() {
		this.pollForNewAccounts = false
	}

	/**
	 * Subscribe to account notifications
	 * @param subscriber Function to be called when a new account is discovered
	 * @returns Function to unsubscribe
	 */
	public subscribe(subscriber: (account: EthereumAddress) => void): () => void {
		this.subscribers.push(subscriber)

		// Return unsubscribe function
		return () => {
			this.unsubscribe(subscriber)
		}
	}

	private notifySubscribers(account: EthereumAddress) {
		this.subscribers.forEach((subscriber) => subscriber(account))
	}

	public unsubscribe(subscriber: (account: EthereumAddress) => void) {
		this.subscribers = this.subscribers.filter((sub) => sub !== subscriber)
	}

	/**
	 * Clears the local account registry cache to reduce database size
	 * @notice This removes all entries with keys starting with "account-registry:" from the database
	 * @dev This will cause the AccountRegistry to re-fetch accounts and block info from the blockchain when needed
	 * @dev After clearing the cache, the AccountRegistry will need to be reinitialized
	 * @returns The number of entries deleted from the database
	 */
	public async clearAccountCache(): Promise<number> {
		if (!this.initialized) await this.init()

		let deletedCount = 0
		const keysToDelete: string[] = []

		// Iterate through all keys in the database with the account-registry: prefix
		for await (const { key } of this.storage.iterate("account-registry:")) {
			keysToDelete.push(key)
		}

		// Delete all marked keys
		for (const key of keysToDelete) {
			await this.storage.delete(key)
			deletedCount++
		}

		// Clear the in-memory accounts array
		this.knownAccounts = []

		// Set initialized to false since we need to reinitialize after clearing the cache
		this.initialized = false

		this.logger.log(`Cleared ${deletedCount} account registry entries`)
		return deletedCount
	}

	/**
	 * Syncs account registry by scanning for new account events from
	 * the last processed block up to the latest block on the chain
	 */
	private async syncFromLastProcessedBlock(): Promise<void> {
		try {
			if (!this.initialized) await this.init()
			const lastProcessedBlockStr = await this.storage.get("account-registry:lastProcessedBlock")
			if (!lastProcessedBlockStr) {
				throw new Error("[AccountRegistry] Missing lastProcessedBlock in storage. Was AccountRegistry initialized?")
			}
			const lastProcessedBlock = Number(lastProcessedBlockStr)

			// Get current block from provider
			const latestBlock = await this.accumulatorContract.getBlockNumber()

			// Don't do anything if we're already up to date
			if (lastProcessedBlock >= latestBlock) {
				this.logger.log("Already up to date")
				return
			}

			let currentBlock = lastProcessedBlock + 1

			// Process in batches to avoid large queries
			while (currentBlock <= latestBlock) {
				const endBlock = Math.min(currentBlock + this.batchSize, latestBlock)
				// Get all NewAccountInitialized events for this batch
				const events: NormalizedNewAccountInitializedEvent[] =
					await this.accumulatorContract.getNewAccountInitializedLogs(currentBlock, endBlock)

				// Process each event to add new accounts
				for (const event of events) {
					const account: EthereumAddress = event.account
					if (!this.knownAccounts.includes(account)) {
						await this.addAccount(account)
					}
				}

				// Update processed block for this batch
				currentBlock = endBlock + 1
				await this.storage.put("account-registry:lastProcessedBlock", endBlock.toString())
			}
		} catch (error: any) {
			this.logger.error(`Error syncing accounts: ${error}`)
		}
	}

	private async addAccount(account: EthereumAddress) {
		if (this.knownAccounts.includes(account)) return
		await this.storage.put(`account-registry:account:${this.knownAccounts.length}`, account.toString())
		this.knownAccounts.push(account)
		this.logger.log(`New account added: ${account.toString()}`)
		this.notifySubscribers(account)
	}

	private async poll() {
		while (this.pollForNewAccounts) {
			try {
				await this.syncFromLastProcessedBlock()
			} catch (error) {
				this.logger.error(`Error in polling loop: ${error}`)
			}
			// Wait pollingIntervalMs milliseconds before the next poll
			if (!this.pollForNewAccounts) break
			await new Promise((resolve) => setTimeout(resolve, this.pollingIntervalMs))
		}
	}
}
