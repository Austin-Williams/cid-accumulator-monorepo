import { EthereumAddress } from "./EthereumAddress.js"
import { CID } from "../ipfs/CID.js"
import { RateLimiter } from "../utils/rateLimiter.js"
import {
	getBlock,
	getBlockByHash,
	getBlockNumber,
	getLeafAppendedLogs,
	getRootCID,
	getNewAccountInitializedLogs,
	getSingletonBirthdayBlockNum,
	getState,
} from "./commonCalls.js"

import type { AccumulatorContractConfig } from "./AccumulatorContract.types.js"
import type { AccumulatorMetadata, PeakWithHeight } from "../mmr/types.js"
import type { LifecycleComponent } from "../types/common.js"
import type { BlockReference, ChainBlock, NormalizedLeafAppendedEvent, NormalizedNewAccountInitializedEvent } from "./events.types.js"

/**
 * A class for CIDAccumulatorSingleton smart contract interactions
 * with rate limiting capabilities
 */
export class AccumulatorContract implements LifecycleComponent {
	private contractAddress: EthereumAddress
	private ethereumHttpRpcUrl: string
	public rateLimiter: RateLimiter

	/**
	 * Creates a new AccumulatorContract instance with optional rate limiting
	 * @param contractAddress Address of the deployed contract
	 * @param ethereumHttpRpcUrl HTTP(S) URL for the Ethereum RPC
	 * @param rateLimiterOptions Optional rate limiter configuration
	 */
	constructor(config: Required<AccumulatorContractConfig>) {
		this.contractAddress =
			config.accumulatorContractAddress instanceof EthereumAddress
				? config.accumulatorContractAddress
				: new EthereumAddress(config.accumulatorContractAddress)
		this.ethereumHttpRpcUrl = config.ethereumHttpRpcUrl
		this.rateLimiter = new RateLimiter(config.rateLimiterOptions)
	}

	init(): Promise<void> {
		return Promise.resolve()
	}

	start(): Promise<void> {
		return Promise.resolve()
	}

	stop(): void {
		this.rateLimiter.clearQueue()
	}
	/**
	 * Get the current block number with rate limiting
	 */
	async getBlockNumber(): Promise<number> {
		return this.rateLimiter.execute(() => getBlockNumber(this.ethereumHttpRpcUrl))
	}

	async getBlock(block: number | "latest" | "finalized"): Promise<ChainBlock> {
		return this.rateLimiter.execute(() => getBlock(this.ethereumHttpRpcUrl, block))
	}

	async getBlockByHash(hash: string): Promise<ChainBlock> {
		return this.rateLimiter.execute(() => getBlockByHash(this.ethereumHttpRpcUrl, hash))
	}

	/**
	 * Get the SINGLETON_BIRTHDAY_BLOCK_NUM from the contract
	 * @returns The block number when the singleton was deployed, as a number
	 */
	async getSingletonBirthdayBlockNum(): Promise<number> {
		let result: number
		result = await this.rateLimiter.execute(() =>
			getSingletonBirthdayBlockNum({
				ethereumHttpRpcUrl: this.ethereumHttpRpcUrl,
				contractAddress: this.contractAddress,
			})
		)
		return result
	}

	/**
	 * Get the state of an account from the contract
	 * @param account The account address to get the state for
	 * @returns The account state including metadata and peaks
	 */
	async getState(account: EthereumAddress, block: BlockReference = "latest"): Promise<{ meta: AccumulatorMetadata; peaks: PeakWithHeight[] }> {
		const result: { meta: AccumulatorMetadata; peaks: PeakWithHeight[] } = await this.rateLimiter.execute(() =>
			getState({
				ethereumHttpRpcUrl: this.ethereumHttpRpcUrl,
				contractAddress: this.contractAddress,
				account,
				block,
			})
		)
		return result
	}

	/**
	 * Get the root CID from the contract
	 * @param account The account address to get the root CID for
	 * @returns The root CID as a CID
	 */
	async getRootCID(account: EthereumAddress, block: BlockReference = "latest"): Promise<CID<unknown, 113, 18, 1>> {
		return this.rateLimiter.execute(() =>
			getRootCID({
				ethereumHttpRpcUrl: this.ethereumHttpRpcUrl,
				contractAddress: this.contractAddress,
				account,
				block,
			})
		)
	}

	/**
	 * Get the leaf appended logs from the contract
	 * @param fromBlock The block number to start from
	 * @param toBlock The block number to end at
	 * @param specificAccounts Optional array of accounts to filter logs by
	 * @returns The leaf appended logs
	 */
	async getLeafAppendedLogs(
		fromBlock: number,
		toBlock: number,
		specificAccounts?: EthereumAddress[],
		blockHash?: string
	): Promise<NormalizedLeafAppendedEvent[]> {
		const result: NormalizedLeafAppendedEvent[] = await this.rateLimiter.execute(() =>
			getLeafAppendedLogs({
				ethereumHttpRpcUrl: this.ethereumHttpRpcUrl,
				contractAddress: this.contractAddress,
				fromBlock,
				toBlock,
				specificAccounts,
				blockHash,
			})
		)
		return result
	}

	/**
	 * Get the new account initialized logs from the contract
	 * @param fromBlock The block number to start from
	 * @param toBlock The block number to end at
	 * @param specificAccounts Optional array of accounts to filter logs by
	 * @returns The new account initialized logs
	 */
	async getNewAccountInitializedLogs(
		fromBlock: number,
		toBlock: number,
		blockHash?: string
	): Promise<NormalizedNewAccountInitializedEvent[]> {
		const result: NormalizedNewAccountInitializedEvent[] = await this.rateLimiter.execute(() =>
			getNewAccountInitializedLogs({
				ethereumHttpRpcUrl: this.ethereumHttpRpcUrl,
				contractAddress: this.contractAddress,
				fromBlock,
				toBlock,
				blockHash,
			})
		)
		return result
	}
}
