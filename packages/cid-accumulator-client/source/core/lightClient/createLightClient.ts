import { AccumulatorContract } from "../../ethereum/AccumulatorContract"
import { defaultLightClientConfig } from "../../config/defaultConfig"
import { EthereumAddress } from "../../ethereum/EthereumAddress"
import { EventCacheService } from "../../services/EventCacheService"
import { IpfsResolver } from "../../ipfs/IpfsResolver"
import { LightClient } from "./LightClient"
import { mergeConfigWithDefaults } from "../../utils/mergeConfigs"
import { UniversalStorageAdapter } from "../../storage/adapters/UniversalStorageAdapter"

import type { DataClientDependencies } from "../dataClient/DataClient.types"
import type { LightClientConfigUserInput } from "./LightClient.types"
import type { Storage } from "../../storage/interface"

/**
 * Creates a light client for a specific account
 * @param account Ethereum address of the account to create a light client for
 * @param options Configuration options for the light client
 * @returns A LightClient instance with start() and stop() methods
 */
export async function createLightClient(
	account: string | EthereumAddress,
	config?: LightClientConfigUserInput
): Promise<LightClient> {
	// Normalize account address
	const accountAddress = account instanceof EthereumAddress ? account : new EthereumAddress(account)

	// Merge user config with default config (user config takes precedence)
	const mergedConfig = mergeConfigWithDefaults(config, defaultLightClientConfig)

	// Create dependencies
	const storage: Storage = new UniversalStorageAdapter(mergedConfig.dbPath)
	const accumulatorContract = new AccumulatorContract(mergedConfig.accumulatorContractConfig)
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
	const lightClient = new LightClient(accountAddress, lightClientDependencies)

	return lightClient
}
