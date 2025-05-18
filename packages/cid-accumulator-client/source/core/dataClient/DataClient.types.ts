import type { AccumulatorContract } from "../../ethereum/AccumulatorContract"
import type { EventCacheService } from "../../services/EventCacheService"
import type { IpfsResolver } from "../../ipfs/IpfsResolver"
import type { Storage } from "../../storage/interface"

export interface DataClientDependencies {
	storage: Storage
	accumulatorContract: AccumulatorContract
	eventCacheService: EventCacheService
	ipfsResolver: IpfsResolver
}
