import type { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import type { EventCacheService } from "../../services/EventCacheService.js"
import type { IpfsResolver } from "../../ipfs/IpfsResolver.js"
import type { Storage } from "../../storage/interface.js"

export interface DataClientDependencies {
	storage: Storage
	accumulatorContract: AccumulatorContract
	eventCacheService: EventCacheService
	ipfsResolver: IpfsResolver
}
