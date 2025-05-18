import type { AccumulatorContractConfig } from "../../ethereum/AccumulatorContract.types"
import type { EventCacheService } from "../../services/EventCacheService"
import type { EventCacheServiceConfig } from "../../services/EventCacheService.types"
import type { IpfsResolver } from "../../ipfs/IpfsResolver"
import type { IpfsResolverConfig } from "../../ipfs/IpfsResolver.types"
import type { Storage } from "../../storage/interface"
import type { DeepPartial } from "../../types/common"

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
