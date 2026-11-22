import type { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import type { EventCacheService } from "../../services/EventCacheService.js"
import type { IpfsResolver } from "../../ipfs/IpfsResolver.js"
import type { CID } from "../../ipfs/CID.js"
import type { Storage } from "../../storage/interface.js"

/** Hex payloads whose count and MMR root were checked against a single contract state read. */
export interface RootSnapshot {
	readonly root: CID<unknown, 113, 27, 1>
	readonly payloads: readonly string[]
}

export interface DataClientDependencies {
	storage: Storage
	accumulatorContract: AccumulatorContract
	eventCacheService: EventCacheService
	ipfsResolver: IpfsResolver
}
