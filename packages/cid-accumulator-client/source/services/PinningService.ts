import { MerkleMountainRange } from "../mmr/MerkleMountainRange.js"
import { createLogger } from "../utils/logging.js"
import { hexStringToUint8Array, uint8ArrayToHexString, cidDataPairArrayToStringForDB } from "../utils/codec.js"
import * as dagCbor from "../utils/dagCbor.js"
import { EthereumAddress } from "../ethereum/EthereumAddress.js"

import type { AccountRegistryService } from "./AccountRegistryService.js"
import type { DataClientManager } from "./DataClientManager.js"
import type { DataClient } from "../core/dataClient/DataClient.js"
import type { IpfsPinner } from "../ipfs/IpfsPinner.js"
import type { Storage } from "../storage/interface.js"
import type { MMRLeafAppendedTrail, LeafRecord } from "../mmr/types.js"
import type { LifecycleComponent } from "../types/common.js"
import {
	getAccountLeafPayloadKey,
	getAccountLeafPayloadCIDKey,
	getAccountLeafRootCIDAfterInsertKey,
	getAccountLeafInsertionTrailKey,
} from "../utils/dbKeys.js"
import { AccumulatorContract } from "../ethereum/AccumulatorContract.js"

/**
 * The PinningService is responsible for ensuring that all CIDs associated with all accounts
 * are pinned to IPFS. It relies on the AccountRegistryService to discover accounts,
 * it gets the corresponding DataClient from the DataClientManager.
 */
export class PinningService implements LifecycleComponent {
	public readonly mmrs: Map<string, MerkleMountainRange> = new Map()
	private mmrSyncing = new Map<string, boolean>()
	private initialized = false
	private isRunning = false
	private storage: Storage
	private accumulatorContract: AccumulatorContract
	private accountRegistryService: AccountRegistryService
	private dataClientManager: DataClientManager
	private ipfsPinner: IpfsPinner
	private logger = createLogger("PinningService")
	private unsubscribeFunctions: (() => void)[] = []
	private syncCheckInterval: ReturnType<typeof setInterval> | null = null
	private syncCheckIntervalMs: number

	/**
	 * Creates a new PinningService instance
	 * @param params Configuration parameters
	 */
	constructor(
		storage: Storage,
		accumulatorContract: AccumulatorContract,
		accountRegistryService: AccountRegistryService,
		dataClientManager: DataClientManager,
		ipfsPinner: IpfsPinner,
		syncCheckIntervalMs: number
	) {
		this.storage = storage
		this.accumulatorContract = accumulatorContract
		this.accountRegistryService = accountRegistryService
		this.dataClientManager = dataClientManager
		this.ipfsPinner = ipfsPinner
		this.syncCheckIntervalMs = syncCheckIntervalMs
	}

	public async init(): Promise<void> {
		await this.ipfsPinner.init()
		this.initialized = true
		this.logger.log("Initializing PinningService")
	}

	public async start(): Promise<void> {
		if (!this.initialized) await this.init()
		if (this.isRunning) {
			this.logger.log("PinningService is already running")
			return
		}
		this.isRunning = true
		this.logger.log("Starting PinningService")
		const accounts: EthereumAddress[] = this.accountRegistryService.knownAccounts

		try {
			await Promise.all(
				accounts.map(async (account) => {
					try {
						await this.trackNewAccount(account)
					} catch (error) {
						this.logger.error(
							`Error tracking new account ${account}: ${error instanceof Error ? error.message : String(error)}`
						)
					}
				})
			)
		} catch (error) {
			this.logger.error(`Error in parallel account tracking: ${error instanceof Error ? error.message : String(error)}`)
		}

		// Subscribe to new accounts
		this.unsubscribeFunctions.push(
			this.accountRegistryService.subscribe((account: EthereumAddress) => {
				this.trackNewAccount(account).catch((error) => {
					this.logger.error(
						`Error tracking new account ${account}: ${error instanceof Error ? error.message : String(error)}`
					)
				})
			})
		)

		//// start periodically sanity checking that local root CIDs match on-chain root CIDs
		this.logger.log(`Starting periodic sanity check with interval of ${this.syncCheckIntervalMs}ms`)
		this.startPeriodicSanityCheck()
	}

	/**
	 * Shuts down the PinningService gracefully
	 */
	public stop(): void {
		if (!this.isRunning) {
			this.logger.log("PinningService is not running")
			return
		}
		this.isRunning = false
		this.logger.log("Stopping PinningService")
		this.stopPeriodicSanityCheck()
		this.unsubscribeFunctions.forEach((fn) => fn())
		this.ipfsPinner.stop()
		this.mmrs.clear()
	}

	/**
	 * Tracks a new account.
	 * Makes sure the DataClient for the account has initially synced.
	 * Pins all not-yet-pinned CIDs to IPFS.
	 * Subscribes to the DataClient to process new payloads as they come in.

	 * @param account The account address
	 */
	public async trackNewAccount(account: EthereumAddress): Promise<void> {
		if (!this.isRunning) {
			this.logger.log("PinningService is not running, skipping trackNewAccount")
			return
		}
		// skip if we already know about this account
		if (this.mmrs.has(account.toString())) return
		// else initialize the new account with an MMR
		this.mmrs.set(account.toString(), new MerkleMountainRange())
		this.mmrSyncing.set(account.toString(), false)

		const dataClient = this.dataClientManager.getOrCreateDataClient(account)
		if (!dataClient.completedInitialSync && !dataClient.syncing) await dataClient.sync()
		await this.pinAllNotYetPinnedCIDsForAccount(account)

		this.unsubscribeFunctions.push(
			dataClient.subscribe((record: LeafRecord) => {
				this.pinAllNotYetPinnedCIDsForAccount(record.account)
			})
		)
	}

	private async pinAllNotYetPinnedCIDsForAccount(account: EthereumAddress): Promise<void> {
		if (!this.isRunning) {
			this.logger.log("PinningService is not running, skipping pinAllNotYetPinnedCIDsForAccount")
			return
		}

		if (this.mmrSyncing.get(account.toString())) {
			this.logger.log(`Account ${account.toString()} is already syncing MMR, skipping pinAllNotYetPinnedCIDsForAccount`)
			return
		} else {
			this.mmrSyncing.set(account.toString(), true)
		}

		const mmr = this.validateAndGetMMR(account)
		const dataClient = await this.validateAndGetDataClient(account)
		const highestInDb = await dataClient.getHighestIndex()

		for (let i = mmr.leafCount; i <= highestInDb; i++) {
			await this.processLeafIndex(account, mmr, i)
		}

		this.mmrSyncing.set(account.toString(), false)
	}

	/**
	 * Validates and returns the MMR for the given account
	 * @param account The account address
	 * @returns The MerkleMountainRange for the account
	 * @throws Error if the MMR is not found
	 */
	private validateAndGetMMR(account: EthereumAddress): MerkleMountainRange {
		const mmr = this.mmrs.get(account.toString())
		if (!mmr) throw new Error(`No MMR found for account ${account.toString()}. This should never happen.`)
		return mmr
	}

	/**
	 * Validates and returns the DataClient for the given account
	 * @param account The account address
	 * @returns The DataClient for the account
	 * @throws Error if the DataClient has not completed initial sync
	 */
	private async validateAndGetDataClient(account: EthereumAddress): Promise<DataClient> {
		const dataClient = this.dataClientManager.getOrCreateDataClient(account)
		if (!dataClient.completedInitialSync) await dataClient.sync()
		if (!dataClient.completedInitialSync)
			throw new Error(`DataClient for account ${account} has not completed initial sync. This should never happen.`)
		return dataClient
	}

	/**
	 * Processes a single leaf index for an account
	 * - Gets the payload from the DB
	 * - Appends it to the MMR (which returns the trail)
	 * - Stores the payload CID, rootCID, and trail in the DB
	 * - Pins the payloadCID and the trail
	 *
	 * @param account The account address
	 * @param mmr The MerkleMountainRange for the account
	 * @param leafIndex The leaf index to process
	 */
	private async processLeafIndex(account: EthereumAddress, mmr: MerkleMountainRange, leafIndex: number): Promise<void> {
		// Get the payload data
		const payloadData = await this.getPayloadData(account, leafIndex)

		// Append to MMR and store metadata
		const trail = await this.appendToMMRAndStoreMetadata(account, mmr, leafIndex, payloadData)

		// Pin to IPFS
		await this.pinTrailToIPFS(trail, account)
	}

	/**
	 * Retrieves and validates the payload data for a leaf index
	 * @param account The account address
	 * @param leafIndex The leaf index
	 * @returns The payload data as Uint8Array
	 * @throws Error if no payload data is found
	 */
	private async getPayloadData(account: EthereumAddress, leafIndex: number): Promise<Uint8Array> {
		const payloadKey = getAccountLeafPayloadKey(account, leafIndex)
		const payloadStr = await this.storage.get(payloadKey)
		if (payloadStr === undefined)
			throw new Error(`No payload data found for leaf index ${leafIndex}. This should never happen.`)
		return hexStringToUint8Array(payloadStr)
	}

	/**
	 * Appends the payload to the MMR and stores metadata in the DB
	 * @param account The account address
	 * @param mmr The MerkleMountainRange for the account
	 * @param leafIndex The leaf index
	 * @param payloadData The payload data
	 * @returns The MMR leaf appended trail
	 * @throws Error if the payload mismatch
	 */
	private async appendToMMRAndStoreMetadata(
		account: EthereumAddress,
		mmr: MerkleMountainRange,
		leafIndex: number,
		payloadData: Uint8Array
	): Promise<MMRLeafAppendedTrail> {
		// Append the payload to the MMR
		const trail: MMRLeafAppendedTrail = await mmr.addLeafWithTrail(leafIndex, payloadData)

		// Sanity check the payload
		const decodedPayload = uint8ArrayToHexString(dagCbor.decode(trail[0].dagCborEncodedData) as Uint8Array)
		const originalPayload = uint8ArrayToHexString(payloadData)
		if (decodedPayload !== originalPayload) {
			throw new Error(`Payload mismatch for leaf index ${leafIndex}. This should never happen.`)
		}

		// Store the payload CID in the DB
		await this.storage.put(getAccountLeafPayloadCIDKey(account, leafIndex), trail[0].cid.toString())

		// Store the root CID after insert in the DB
		await this.storage.put(
			getAccountLeafRootCIDAfterInsertKey(account, leafIndex),
			trail[trail.length - 1].cid.toString()
		)

		// Store the insertion trail (but not the payloadCID/payload) in the DB
		const trailWithoutPayload = trail.slice(1)
		await this.storage.put(
			getAccountLeafInsertionTrailKey(account, leafIndex),
			cidDataPairArrayToStringForDB(trailWithoutPayload)
		)

		return trail
	}

	/**
	 * Pins the trail to IPFS
	 * @param trail The MMR leaf appended trail
	 */
	private async pinTrailToIPFS(trail: MMRLeafAppendedTrail, account: EthereumAddress): Promise<void> {
		// Pin the payload
		await this.ipfsPinner.putAndPin({ cid: trail[0].cid, dagCborEncodedData: trail[0].dagCborEncodedData }, account)

		// Pin the trail (excluding the payload)
		const trailWithoutPayload = trail.slice(1)
		for (const cidDataPair of trailWithoutPayload) {
			await this.ipfsPinner.putAndPin(cidDataPair, account)
		}
	}

	private async sanityCheck(): Promise<void> {
		try {
			this.logger.log("Starting periodic check of local MMR root CIDs vs on-chain root CIDs")
			// For all accounts in mmrs, verify the root CID
			for (const account of this.mmrs.keys()) {
				this.verifyRootCIDs(EthereumAddress.fromString(account))
					.then((result) => {
						if (!result) {
							this.logger.warn(`Root CID verification failed for account ${account}. Syncing the local MMR...`)
							this.pinAllNotYetPinnedCIDsForAccount(EthereumAddress.fromString(account)).catch((error) => {
								this.logger.error(
									`Error syncing MMR for account ${account}: ${error instanceof Error ? error.message : String(error)}`
								)
							})
						}
					})
					.catch((error) => {
						this.logger.error(
							`Error verifying root CID for account ${account}: ${
								error instanceof Error ? error.message : String(error)
							}`
						)
					})
			}
		} catch (error) {
			this.logger.error(`Error during periodic sanity check: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/**
	 * Starts the periodic sanity check to ensure all MMRs for all accounts are up to date
	 * @private
	 */
	private async startPeriodicSanityCheck(): Promise<void> {
		if (!this.isRunning) {
			this.logger.log("PinningService is not running, skipping startPeriodicSanityCheck")
			return
		}
		// Run it once right away
		await this.sanityCheck()

		// Set up a new interval
		this.syncCheckInterval = setInterval(this.sanityCheck.bind(this), this.syncCheckIntervalMs)
	}

	/**
	 * Stops the periodic sanity check
	 * @private
	 */
	private stopPeriodicSanityCheck(): void {
		if (this.syncCheckInterval) {
			clearInterval(this.syncCheckInterval)
			this.syncCheckInterval = null
			this.logger.log("Periodic sanity check stopped")
		}
	}

	/**
	 * Verifies that the on-chain root CID matches our local MMR root CID
	 * @param account Account to verify
	 * @returns boolean
	 */
	public async verifyRootCIDs(account: EthereumAddress): Promise<boolean> {
		if (!this.isRunning) {
			this.logger.log("PinningService is not running, skipping verifyRootCIDs")
			return false
		}

		// Skip if MMR is empty
		const mmr = this.mmrs.get(account.toString())
		if (!mmr || mmr.leafCount === 0) return false

		// 1. Get the on-chain root CID from the contract
		const onChainRootCID = await this.accumulatorContract.getRootCID(account)

		// 2. Get the local root CID from our MMR
		const localRootCID = await mmr.rootCID()

		// 3. Compare them
		const match = onChainRootCID.toString() === localRootCID.toString()

		if (match) {
			this.logger.log(`[${account.toString()}] Root CID (${onChainRootCID.toString()}) verification: OK`)
			return true
		} else {
			this.logger.warn(
				`[${account.toString()}] Root CID mismatch! ` +
					`On-chain: ${onChainRootCID.toString()} ` +
					`Local: ${localRootCID.toString()} ` +
					`This usually means the local MMR is not up to date with the contract, and resolves itself after syncing the local MMR for the account.`
			)
			return false
		}
	}
}
