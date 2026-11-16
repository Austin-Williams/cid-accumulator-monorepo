import type { AccumulatorContractConfig } from "../ethereum/AccumulatorContract.types.js"
import type { AccountRegistryServiceConfig } from "../services/AccountRegistryService.types.js"
import type { EventCacheServiceConfig } from "../services/EventCacheService.types.js"
import type { SeederConfig } from "../core/seeder/Seeder.types.js"
import type { IpfsPinnerConfig } from "../ipfs/IpfsPinner.types.js"
import type { IpfsResolverConfig } from "../ipfs/IpfsResolver.types.js"
import type { LightClientConfig } from "../core/lightClient/LightClient.types.js"
import type { RateLimiterOptions } from "../types/common.js"

// ETHEREUM
export const defaultLightClientEthereumHttpRpcUrl = "https://ethereum-rpc.publicnode.com"
export const defaultSeederEthereumHttpRpcUrl = "http://127.0.0.1:8545"

export const defaultLightClientEthereumRpcRateLimiterOptions: Required<RateLimiterOptions> = {
	intervalMs: 2000,
	maxRetries: 3,
	baseDelay: 1000,
	capDelay: 10000,
}
export const defaultSeederEthereumRpcRateLimiterOptions: Required<RateLimiterOptions> = {
	intervalMs: 10,
	maxRetries: 5,
	baseDelay: 100,
	capDelay: 5000,
}
export const defaultLightClientAccumulatorContractConfig: Omit<AccumulatorContractConfig, "accumulatorContractAddress"> = {
	ethereumHttpRpcUrl: defaultLightClientEthereumHttpRpcUrl,
	rateLimiterOptions: defaultLightClientEthereumRpcRateLimiterOptions,
}
export const defaultSeederAccumulatorContractConfig: Omit<AccumulatorContractConfig, "accumulatorContractAddress"> = {
	ethereumHttpRpcUrl: defaultSeederEthereumHttpRpcUrl,
	rateLimiterOptions: defaultSeederEthereumRpcRateLimiterOptions,
}

// IPFS GATEWAY (RESOLVER)
export const defaultLightClientIpfsGatewayUrl = "http://127.0.0.1:8080"
export const defaultSeederIpfsGatewayUrl = "http://127.0.0.1:8080"

export const defaultLightClientIpfsGatewayRateLimiterOptions: Required<RateLimiterOptions> = {
	intervalMs: 200,
	maxRetries: 3,
	baseDelay: 500,
	capDelay: 10000,
}
export const defaultSeederIpfsGatewayRateLimiterOptions: Required<RateLimiterOptions> = {
	intervalMs: 10,
	maxRetries: 5,
	baseDelay: 100,
	capDelay: 5000,
}


export const defaultLightClientIpfsResolverConfig: Required<IpfsResolverConfig> = {
	gatewayUrl: defaultLightClientIpfsGatewayUrl,
	rateLimiterOptions: defaultLightClientIpfsGatewayRateLimiterOptions,
}
export const defaultSeederIpfsResolverConfig: Required<IpfsResolverConfig> = {
	gatewayUrl: defaultSeederIpfsGatewayUrl,
	rateLimiterOptions: defaultSeederIpfsGatewayRateLimiterOptions,
}

// IPFS PINNER (NODE)
export const defaultRemotePinningServiceRateLimiterOptions: Required<RateLimiterOptions> = {
	intervalMs: 500,
	maxRetries: 3,
	baseDelay: 100,
	capDelay: 10000,
}
export const defaultIpfsPinnerConfig: Required<IpfsPinnerConfig> = {
	baseUrl: "http://127.0.0.1:5001/api/v0",
	remotePin: false,
	remotePinningServiceRateLimiterOptions: defaultRemotePinningServiceRateLimiterOptions,
}

// SERVICES
// Account Registry Service
export const defaultLightClientAccountRegistryServiceConfig: Required<AccountRegistryServiceConfig> = {
	specificAccountsOnly: [],
	pollingIntervalMs: 60000, // 1 minute
	batchSize: 1000,
}
export const defaultSeederAccountRegistryServiceConfig: Required<AccountRegistryServiceConfig> = {
	specificAccountsOnly: [],
	pollingIntervalMs: 12000, // 12 seconds
	batchSize: 10000,
}

// Event Cache Service
export const defaultLightClientEventCacheServiceConfig: Required<EventCacheServiceConfig> = {
	lazyLoadEvents: true,
	pollingIntervalMs: 12000,
	specificAccountsOnly: [],
}
export const defaultSeederEventCacheServiceConfig: Required<EventCacheServiceConfig> = {
	lazyLoadEvents: true,
	pollingIntervalMs: 5000,
	specificAccountsOnly: [],
}

// Pinning Service
export const defaultSyncCheckIntervalMs = 1 * 60 * 1000 // 60 seconds by default

// CLIENTS
// Light Client
export const defaultLightClientConfig = {
	nodeDbPath: "./db/cid-accumulator-light-client.json",
	browserDbName: "cid-accumulator",
	accumulatorContractConfig: defaultLightClientAccumulatorContractConfig,
	eventCacheServiceConfig: defaultLightClientEventCacheServiceConfig,
	ipfsResolverConfig: defaultLightClientIpfsResolverConfig,
} satisfies Omit<Required<LightClientConfig>, "accumulatorContractConfig"> & {
	accumulatorContractConfig: Omit<AccumulatorContractConfig, "accumulatorContractAddress">
}

// Seeder
export const defaultSeederConfig = {
	nodeDbPath: "./db/cid-accumulator-seeder.json",
	browserDbName: "cid-accumulator",
	accumulatorContractConfig: defaultSeederAccumulatorContractConfig,
	accountRegistryServiceConfig: defaultSeederAccountRegistryServiceConfig,
	eventCacheServiceConfig: defaultSeederEventCacheServiceConfig,
	ipfsResolverConfig: defaultSeederIpfsResolverConfig,
	ipfsPinnerConfig: defaultIpfsPinnerConfig,
	syncCheckIntervalMs: defaultSyncCheckIntervalMs,
} satisfies Omit<SeederConfig, "accumulatorContractConfig"> & {
	accumulatorContractConfig: Omit<AccumulatorContractConfig, "accumulatorContractAddress">
}
