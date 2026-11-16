import { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import { AccountRegistryService } from "../../services/AccountRegistryService.js"
import { DataClientManager } from "../../services/DataClientManager.js"
import { defaultSeederConfig } from "../../config/defaultConfig.js"
import { EventCacheService } from "../../services/EventCacheService.js"
import { IpfsPinner } from "../../ipfs/IpfsPinner.js"
import { IpfsResolver } from "../../ipfs/IpfsResolver.js"
import { mergeConfigWithDefaults } from "../../utils/mergeConfigs.js"
import { PinningService } from "../../services/PinningService.js"
import { Seeder } from "./Seeder.js"
import { UniversalStorageAdapter } from "../../storage/adapters/UniversalStorageAdapter.js"

import type { SeederConfigUserInput, SeederDependencies } from "./Seeder.types.js"
import type { Storage } from "../../storage/interface.js"

/**
 * Creates a seeder for a all accounts (or optionall just for specific accounts)
 * @param config Configuration options for the seeder
 * @returns A Seeder instance
 */
export async function createSeeder(config: SeederConfigUserInput): Promise<Seeder> {
	// Merge user config with default config (user config takes precedence)
	const accumulatorContractAddress = config?.accumulatorContractConfig?.accumulatorContractAddress
	if (!accumulatorContractAddress) throw new Error("accumulatorContractConfig.accumulatorContractAddress is required")
	const mergedConfig = mergeConfigWithDefaults(config, {
		...defaultSeederConfig,
		accumulatorContractConfig: {
			...defaultSeederConfig.accumulatorContractConfig,
			accumulatorContractAddress,
		},
	})

	// Create dependencies
	const storage: Storage = new UniversalStorageAdapter(
		`${mergedConfig.nodeDbPath}-${mergedConfig.accumulatorContractConfig.accumulatorContractAddress}`,
		mergedConfig.browserDbName
	)
	const accumulatorContract = new AccumulatorContract(mergedConfig.accumulatorContractConfig)
	const accountRegistryService = new AccountRegistryService(
		storage,
		accumulatorContract,
		mergedConfig.accountRegistryServiceConfig
	)
	const eventCacheService = new EventCacheService(storage, accumulatorContract, mergedConfig.eventCacheServiceConfig)
	const ipfsResolver: IpfsResolver = new IpfsResolver(storage, mergedConfig.ipfsResolverConfig)
	const dataClientManager = new DataClientManager(
		storage,
		accumulatorContract,
		accountRegistryService,
		eventCacheService,
		ipfsResolver
	)
	const ipfsPinner = new IpfsPinner(storage, mergedConfig.ipfsPinnerConfig)
	const pinningService = new PinningService(
		storage,
		accumulatorContract,
		accountRegistryService,
		dataClientManager,
		ipfsPinner,
		mergedConfig.syncCheckIntervalMs
	)

	const seederDependencies: SeederDependencies = {
		storage: storage,
		accumulatorContract: accumulatorContract,
		eventCacheService: eventCacheService,
		accountRegistryService: accountRegistryService,
		dataClientManager: dataClientManager,
		pinningService: pinningService,
	}

	const seeder = new Seeder(seederDependencies)

	return seeder
}
