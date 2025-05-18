import { AccumulatorContract } from "../../ethereum/AccumulatorContract"
import { AccountRegistryService } from "../../services/AccountRegistryService"
import { DataClientManager } from "../../services/DataClientManager"
import { defaultSeederConfig } from "../../config/defaultConfig"
import { EventCacheService } from "../../services/EventCacheService"
import { IpfsPinner } from "../../ipfs/IpfsPinner"
import { IpfsResolver } from "../../ipfs/IpfsResolver"
import { mergeConfigWithDefaults } from "../../utils/mergeConfigs"
import { PinningService } from "../../services/PinningService"
import { Seeder } from "./Seeder"
import { UniversalStorageAdapter } from "../../storage/adapters/UniversalStorageAdapter"

import type { SeederConfigUserInput, SeederDependencies } from "./Seeder.types"
import type { Storage } from "../../storage/interface"

/**
 * Creates a seeder for a all accounts (or optionall just for specific accounts)
 * @param options Configuration options for the seeder
 * @returns A Seeder instance
 */
export async function createSeeder(config?: SeederConfigUserInput): Promise<Seeder> {
	// Merge user config with default config (user config takes precedence)
	const mergedConfig = mergeConfigWithDefaults(config, defaultSeederConfig)

	console.log("\n==== Seeder Configuration ====")
	console.log(JSON.stringify(mergedConfig, null, 2))

	// Create dependencies
	const storage: Storage = new UniversalStorageAdapter(`${mergedConfig.dbPath}-${mergedConfig.accumulatorContractConfig.accumulatorContractAddress}`)
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
