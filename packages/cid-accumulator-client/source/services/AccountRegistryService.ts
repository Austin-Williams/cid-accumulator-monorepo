import { EthereumAddress } from "../ethereum/EthereumAddress.js"
import { createLogger } from "../utils/logging.js"
import type { AccountRegistryServiceConfig } from "./AccountRegistryService.types.js"
import type { Logger } from "../types/common.js"
import type { AccumulatorContract } from "../ethereum/AccumulatorContract.js"
import type { Storage } from "../storage/interface.js"
import type { LifecycleComponent } from "../types/common.js"
import type { NormalizedNewAccountInitializedEvent } from "../ethereum/events.types.js"
import { getChainState } from "./ChainState.js"
import type { ChainState } from "./ChainState.js"

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
	private chain?: ChainState
	private unsubscribeReset?: () => void
	private needsReload = false
	private pollingGeneration = 0

	constructor(
		storage: Storage,
		accumulatorContract: AccumulatorContract,
		config: Required<AccountRegistryServiceConfig>
	) {
		this.storage = storage
		this.accumulatorContract = accumulatorContract
		// Discovery and cache hydration must not mutate the caller's configuration.
		this.knownAccounts = [...config.specificAccountsOnly]
		this.pollingIntervalMs = config.pollingIntervalMs
		this.batchSize = config.batchSize
		this.logger = createLogger("AccountRegistry")
		if (config.specificAccountsOnly.length > 0) this.specificAccountsMode = true
	}

	public async init() {
		try {
			this.chain ??= await getChainState(this.storage, this.accumulatorContract)
			this.unsubscribeReset ??= this.chain.subscribeReset(() => { this.needsReload = true })
			const snapshot = await this.chain.snapshot()
			// Get singleton birthday block
			let singletonBirthdayBlock: string | undefined = await this.storage.get("account-registry:singletonBirthdayBlock")
			if (!singletonBirthdayBlock) {
				singletonBirthdayBlock = (await this.accumulatorContract.getSingletonBirthdayBlockNum()).toString()
				if (!singletonBirthdayBlock) throw new Error("Failed to get singleton birthday block")
				await this.chain.commit(snapshot, () => this.storage.put("account-registry:singletonBirthdayBlock", singletonBirthdayBlock!))
			}

			if (!this.specificAccountsMode) {
				// Get highest processed block
				const lastProcessedBlock = await this.storage.get("account-registry:lastProcessedBlock")
				if (!lastProcessedBlock) {
					await this.chain.commit(snapshot, () => this.storage.put("account-registry:lastProcessedBlock", String(Math.max(0, Number(singletonBirthdayBlock) - 1))))
				}

				// Get all known accounts from DB
				await this.reloadAccounts()
			}
			this.initialized = true

			this.logger.log(`Initialized with ${this.knownAccounts.length} accounts`)
		} catch (error) {
			this.unsubscribeReset?.()
			this.unsubscribeReset = undefined
			this.logger.error(`Error during initialization: ${error}`)
			throw error
		}
	}

	public async start() {
		if (this.pollForNewAccounts) return
		const generation = ++this.pollingGeneration
		if (!this.initialized) await this.init()
		this.unsubscribeReset ??= this.chain!.subscribeReset(() => { this.needsReload = true })
		await this.chain!.snapshot()
		if (this.needsReload) await this.reloadAccounts()
		if (generation !== this.pollingGeneration) return
		this.pollForNewAccounts = !this.specificAccountsMode
		// Notify subscribers of all known accounts
		for (const account of this.knownAccounts) {
			this.notifySubscribers(account)
		}

		if (!this.isCurrentPoll(generation)) return
		// fire and forget
		this.poll(generation).catch((error) => {
			this.logger.error(`Error in polling loop: ${error}`)
		})
	}

	public stop() {
		this.pollForNewAccounts = false
		this.pollingGeneration++
		this.needsReload = true
		this.unsubscribeReset?.()
		this.unsubscribeReset = undefined
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
		const snapshot = await this.chain!.snapshot()
		return this.chain!.commit(snapshot, async () => {

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
		})
	}

	/**
	 * Syncs account registry by scanning for new account events from
	 * the last processed block up to the latest block on the chain
	 */
	private async syncFromLastProcessedBlock(generation: number): Promise<void> {
		try {
			if (!this.isCurrentPoll(generation)) return
			if (!this.initialized) await this.init()
			const chain = this.chain!
			const snapshot = await chain.snapshot()
			if (this.needsReload) await this.reloadAccounts()
			if (!this.isCurrentPoll(generation)) return
			const lastProcessedBlockStr = await this.storage.get("account-registry:lastProcessedBlock")
			if (!lastProcessedBlockStr) {
				throw new Error("[AccountRegistry] Missing lastProcessedBlock in storage. Was AccountRegistry initialized?")
			}
			const lastProcessedBlock = Number(lastProcessedBlockStr)

			// Get current block from provider
			const latestBlock = snapshot.block.number

			// Don't do anything if we're already up to date
			if (lastProcessedBlock >= latestBlock) {
				this.logger.log("Already up to date")
				return
			}

			let currentBlock = lastProcessedBlock + 1
			const finalized = await this.accumulatorContract.getBlock("finalized")

			// Process in batches to avoid large queries
			while (currentBlock <= latestBlock && this.isCurrentPoll(generation)) {
				const endBlock = currentBlock <= finalized.number
					? Math.min(currentBlock + this.batchSize, latestBlock, finalized.number)
					: currentBlock
				const blockHash = currentBlock > finalized.number
					? (await chain.getBlock(snapshot, currentBlock)).hash
					: undefined
				// Get all NewAccountInitialized events for this batch
				const events: NormalizedNewAccountInitializedEvent[] =
					await this.accumulatorContract.getNewAccountInitializedLogs(currentBlock, endBlock, blockHash)

				if (!this.isCurrentPoll(generation)) return
				await chain.ensureCanonical(snapshot)
				await chain.commit(snapshot, async () => {
					for (const event of events) {
						if (!this.isCurrentPoll(generation)) return
						await this.addAccount(event.account, event.blockNumber)
					}
					if (!this.isCurrentPoll(generation)) return
					await this.storage.put("account-registry:lastProcessedBlock", endBlock.toString())
				})

				// Update processed block for this batch
				currentBlock = endBlock + 1
			}
		} catch (error: any) {
			this.logger.error(`Error syncing accounts: ${error}`)
		}
	}

	private async addAccount(account: EthereumAddress, blockNumber: number) {
		if (this.knownAccounts.some((known) => known.toString() === account.toString())) return
		await this.storage.put(`account-registry:discovered:${account}`, blockNumber.toString())
		await this.storage.put(`account-registry:account:${this.knownAccounts.length}`, account.toString())
		this.knownAccounts.push(account)
		this.logger.log(`New account added: ${account.toString()}`)
		this.notifySubscribers(account)
	}

	private async reloadAccounts(): Promise<void> {
		if (this.specificAccountsMode) {
			this.needsReload = false
			return
		}
		await this.chain!.read(async () => {
			const accounts: EthereumAddress[] = []
			for await (const record of this.storage.iterate("account-registry:account:")) {
				accounts.push(EthereumAddress.fromString(record.value))
			}
			this.knownAccounts = accounts
			this.needsReload = false
		})
	}

	private isCurrentPoll(generation: number): boolean {
		return this.pollForNewAccounts && generation === this.pollingGeneration
	}

	private async poll(generation: number) {
		while (this.isCurrentPoll(generation)) {
			try {
				await this.syncFromLastProcessedBlock(generation)
			} catch (error) {
				this.logger.error(`Error in polling loop: ${error}`)
			}
			// Wait pollingIntervalMs milliseconds before the next poll
			if (!this.isCurrentPoll(generation)) break
			await new Promise((resolve) => setTimeout(resolve, this.pollingIntervalMs))
		}
	}
}
