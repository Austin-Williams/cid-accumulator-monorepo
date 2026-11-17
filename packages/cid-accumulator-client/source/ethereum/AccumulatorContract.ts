import { EthereumAddress } from "./EthereumAddress.js"
import { RateLimiter } from "../utils/rateLimiter.js"
import {
	getBlock,
	getBlockByHash,
	getBlockNumber,
	getChainId,
	getLeafAppendedLogs,
	getRootCID,
	getState,
} from "./commonCalls.js"

import type { CID } from "../ipfs/CID.js"
import type { AccumulatorContractConfig } from "./AccumulatorContract.types.js"
import type { AccumulatorMetadata, PeakWithHeight } from "../mmr/types.js"
import type { LifecycleComponent } from "../types/common.js"
import type { BlockReference, ChainBlock, NormalizedLeafAppendedEvent } from "./events.types.js"

/** Rate-limited calls to one application inheriting CIDAccumulator. */
export class AccumulatorContract implements LifecycleComponent {
	public readonly address: EthereumAddress
	private ethereumHttpRpcUrl: string
	public rateLimiter: RateLimiter

	constructor(config: Required<AccumulatorContractConfig>) {
		this.address = config.accumulatorContractAddress instanceof EthereumAddress
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

	async getBlockNumber(): Promise<number> {
		return this.rateLimiter.execute(() => getBlockNumber(this.ethereumHttpRpcUrl))
	}

	async getChainId(): Promise<bigint> {
		return this.rateLimiter.execute(() => getChainId(this.ethereumHttpRpcUrl))
	}

	async getBlock(block: number | "latest" | "finalized"): Promise<ChainBlock> {
		return this.rateLimiter.execute(() => getBlock(this.ethereumHttpRpcUrl, block))
	}

	async getBlockByHash(hash: string): Promise<ChainBlock> {
		return this.rateLimiter.execute(() => getBlockByHash(this.ethereumHttpRpcUrl, hash))
	}

	async getState(block: BlockReference = "latest"): Promise<{ meta: AccumulatorMetadata; peaks: PeakWithHeight[] }> {
		return this.rateLimiter.execute(() => getState({
			ethereumHttpRpcUrl: this.ethereumHttpRpcUrl,
			contractAddress: this.address,
			block,
		}))
	}

	async getRootCID(block: BlockReference = "latest"): Promise<CID<unknown, 113, 27, 1>> {
		return this.rateLimiter.execute(() => getRootCID({
			ethereumHttpRpcUrl: this.ethereumHttpRpcUrl,
			contractAddress: this.address,
			block,
		}))
	}

	async getLeafAppendedLogs(
		fromBlock: number,
		toBlock: number,
		blockHash?: string
	): Promise<NormalizedLeafAppendedEvent[]> {
		return this.rateLimiter.execute(() => getLeafAppendedLogs({
			ethereumHttpRpcUrl: this.ethereumHttpRpcUrl,
			contractAddress: this.address,
			fromBlock,
			toBlock,
			blockHash,
		}))
	}
}
