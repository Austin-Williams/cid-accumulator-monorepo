import { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import { defaultLightClientConfig } from "../../config/defaultConfig.js"
import { EventCacheService } from "../../services/EventCacheService.js"
import { IpfsResolver } from "../../ipfs/IpfsResolver.js"
import { LightClient } from "./LightClient.js"
import { mergeConfigWithDefaults } from "../../utils/mergeConfigs.js"
import { UniversalStorageAdapter } from "../../storage/adapters/UniversalStorageAdapter.js"
import { AccumulatorStorageAdapter } from "../../storage/adapters/AccumulatorStorageAdapter.js"

import type { DataClientDependencies } from "../dataClient/DataClient.types.js"
import type { LightClientConfigUserInput } from "./LightClient.types.js"
import type { Storage } from "../../storage/interface.js"

/**
 * Creates a light client for the configured inheriting accumulator contract.
 * @param config Configuration options for the light client
 * @returns A LightClient instance with start() and stop() methods
 */
export async function createLightClient(
	config: LightClientConfigUserInput
): Promise<LightClient> {
	// Merge user config with default config (user config takes precedence)
	const accumulatorContractAddress = config?.accumulatorContractConfig?.accumulatorContractAddress
	if (!accumulatorContractAddress) throw new Error("accumulatorContractConfig.accumulatorContractAddress is required")
	const mergedConfig = mergeConfigWithDefaults(config, {
		...defaultLightClientConfig,
		accumulatorContractConfig: {
			...defaultLightClientConfig.accumulatorContractConfig,
			accumulatorContractAddress,
		},
	})

	// Create dependencies
	const accumulatorContract = new AccumulatorContract(mergedConfig.accumulatorContractConfig)
	const storage: Storage = new AccumulatorStorageAdapter(
		new UniversalStorageAdapter(mergedConfig.nodeDbPath, mergedConfig.browserDbName),
		accumulatorContract
	)
	const eventCacheService = new EventCacheService(storage, accumulatorContract, mergedConfig.eventCacheServiceConfig)
	const ipfsResolver: IpfsResolver = new IpfsResolver(storage, mergedConfig.ipfsResolverConfig)

	// Initialize services
	const lightClientDependencies: DataClientDependencies = {
		storage: storage,
		accumulatorContract: accumulatorContract,
		eventCacheService: eventCacheService,
		ipfsResolver: ipfsResolver,
	}

	// Create the LightClient
	const lightClient = new LightClient(lightClientDependencies)

	return lightClient
}
