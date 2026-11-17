import type { AccumulatorContractConfig, AccumulatorContractConfigUserInput } from "../../ethereum/AccumulatorContract.types.js"
import type { EventCacheServiceConfig } from "../../services/EventCacheService.types.js"
import type { IpfsResolverConfig } from "../../ipfs/IpfsResolver.types.js"
import type { IpfsPinnerConfig } from "../../ipfs/IpfsPinner.types.js"
import type { Storage, StorageConfig } from "../../storage/interface.js"
import type { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import type { EventCacheService } from "../../services/EventCacheService.js"
import type { LightClient } from "../lightClient/LightClient.js"
import type { PinningService } from "../../services/PinningService.js"
import type { DeepPartial } from "../../types/common.js"

export interface SeederConfigUserInput extends DeepPartial<SeederConfig> {
	accumulatorContractConfig: AccumulatorContractConfigUserInput
}

export interface SeederConfig extends StorageConfig {
	accumulatorContractConfig: Required<AccumulatorContractConfig>
	eventCacheServiceConfig: Required<EventCacheServiceConfig>
	ipfsResolverConfig: Required<IpfsResolverConfig>
	ipfsPinnerConfig: Required<IpfsPinnerConfig>
	syncCheckIntervalMs: number
}

export interface SeederDependencies {
	storage: Storage
	accumulatorContract: AccumulatorContract
	eventCacheService: EventCacheService
	dataClient: LightClient
	pinningService: PinningService
}
