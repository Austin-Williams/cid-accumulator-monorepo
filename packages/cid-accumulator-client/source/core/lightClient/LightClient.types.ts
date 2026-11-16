import type { AccumulatorContractConfig } from "../../ethereum/AccumulatorContract.types.js"
import type { EventCacheService } from "../../services/EventCacheService.js"
import type { EventCacheServiceConfig } from "../../services/EventCacheService.types.js"
import type { IpfsResolver } from "../../ipfs/IpfsResolver.js"
import type { IpfsResolverConfig } from "../../ipfs/IpfsResolver.types.js"
import type { Storage } from "../../storage/interface.js"
import type { DeepPartial } from "../../types/common.js"

export interface LightClientConfigUserInput extends DeepPartial<LightClientConfig> {}

export interface LightClientConfig {
	dbPath: string
	accumulatorContractConfig: Required<AccumulatorContractConfig>
	eventCacheServiceConfig: Required<EventCacheServiceConfig>
	ipfsResolverConfig: Required<IpfsResolverConfig>
}

export interface LightClientDependencies {
	storage: Storage
	eventCacheService: EventCacheService
	ipfsResolver: IpfsResolver
}
