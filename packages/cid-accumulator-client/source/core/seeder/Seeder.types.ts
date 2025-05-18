import type { AccumulatorContractConfig } from "../../ethereum/AccumulatorContract.types"
import type { AccountRegistryServiceConfig } from "../../services/AccountRegistryService.types"
import type { EventCacheServiceConfig } from "../../services/EventCacheService.types"
import type { IpfsResolverConfig } from "../../ipfs/IpfsResolver.types"
import type { IpfsPinnerConfig } from "../../ipfs/IpfsPinner.types"
import type { Storage } from "../../storage/interface"
import type { AccumulatorContract } from "../../ethereum/AccumulatorContract"
import type { EventCacheService } from "../../services/EventCacheService"
import type { AccountRegistryService } from "../../services/AccountRegistryService"
import type { DataClientManager } from "../../services/DataClientManager"
import type { PinningService } from "../../services/PinningService"
import type { DeepPartial } from "../../types/common"

export interface SeederConfigUserInput extends DeepPartial<SeederConfig> {}

export interface SeederConfig {
	dbPath: string
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
