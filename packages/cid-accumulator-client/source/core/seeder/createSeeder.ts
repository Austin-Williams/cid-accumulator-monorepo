import { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import { defaultSeederConfig } from "../../config/defaultConfig.js"
import { EventCacheService } from "../../services/EventCacheService.js"
import { IpfsPinner } from "../../ipfs/IpfsPinner.js"
import { IpfsResolver } from "../../ipfs/IpfsResolver.js"
import { mergeConfigWithDefaults } from "../../utils/mergeConfigs.js"
import { PinningService } from "../../services/PinningService.js"
import { Seeder } from "./Seeder.js"
import { LightClient } from "../lightClient/LightClient.js"
import { UniversalStorageAdapter } from "../../storage/adapters/UniversalStorageAdapter.js"
import { AccumulatorStorageAdapter } from "../../storage/adapters/AccumulatorStorageAdapter.js"
import type { SeederConfigUserInput } from "./Seeder.types.js"

/** Creates a seeder for one explicitly configured accumulator contract. */
export async function createSeeder(config: SeederConfigUserInput): Promise<Seeder> {
	const accumulatorContractAddress = config?.accumulatorContractConfig?.accumulatorContractAddress
	if (!accumulatorContractAddress) throw new Error("accumulatorContractConfig.accumulatorContractAddress is required")
	const mergedConfig = mergeConfigWithDefaults(config, {
		...defaultSeederConfig,
		accumulatorContractConfig: {
			...defaultSeederConfig.accumulatorContractConfig,
			accumulatorContractAddress,
		},
	})
	const accumulatorContract = new AccumulatorContract(mergedConfig.accumulatorContractConfig)
	const storage = new AccumulatorStorageAdapter(
		new UniversalStorageAdapter(mergedConfig.nodeDbPath, mergedConfig.browserDbName),
		accumulatorContract
	)
	const eventCacheService = new EventCacheService(storage, accumulatorContract, mergedConfig.eventCacheServiceConfig)
	const ipfsResolver = new IpfsResolver(storage, mergedConfig.ipfsResolverConfig)
	const dataClient = new LightClient({ storage, accumulatorContract, eventCacheService, ipfsResolver })
	const ipfsPinner = new IpfsPinner(mergedConfig.ipfsPinnerConfig)
	const pinningService = new PinningService(
		storage, accumulatorContract, dataClient, ipfsPinner, mergedConfig.syncCheckIntervalMs, mergedConfig.retainedRoots
	)
	return new Seeder({ storage, accumulatorContract, eventCacheService, dataClient, pinningService })
}
