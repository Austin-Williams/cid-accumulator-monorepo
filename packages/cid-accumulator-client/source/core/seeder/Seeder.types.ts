import type { AccumulatorContractConfig } from "../../ethereum/AccumulatorContract.types.js"
import type { AccountRegistryServiceConfig } from "../../services/AccountRegistryService.types.js"
import type { EventCacheServiceConfig } from "../../services/EventCacheService.types.js"
import type { IpfsResolverConfig } from "../../ipfs/IpfsResolver.types.js"
import type { IpfsPinnerConfig } from "../../ipfs/IpfsPinner.types.js"
import type { Storage, StorageConfig } from "../../storage/interface.js"
import type { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import type { EventCacheService } from "../../services/EventCacheService.js"
import type { AccountRegistryService } from "../../services/AccountRegistryService.js"
import type { DataClientManager } from "../../services/DataClientManager.js"
import type { PinningService } from "../../services/PinningService.js"
import type { DeepPartial } from "../../types/common.js"

export interface SeederConfigUserInput extends DeepPartial<SeederConfig> {}

export interface SeederConfig extends StorageConfig {
	accumulatorContractConfig: Required<AccumulatorContractConfig>
	accountRegistryServiceConfig: Required<AccountRegistryServiceConfig>
	eventCacheServiceConfig: Required<EventCacheServiceConfig>
	ipfsResolverConfig: Required<IpfsResolverConfig>
	ipfsPinnerConfig: Required<IpfsPinnerConfig>
	syncCheckIntervalMs: number
}

export interface SeederDependencies {
	storage: Storage
	accumulatorContract: AccumulatorContract
	eventCacheService: EventCacheService
	accountRegistryService: AccountRegistryService
	dataClientManager: DataClientManager
	pinningService: PinningService
}
