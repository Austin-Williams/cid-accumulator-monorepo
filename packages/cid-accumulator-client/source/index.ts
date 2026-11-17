// Re-export constants
export { NULL_CID } from "./utils/constants.js"

// Core
export { createLightClient } from "./core/lightClient/createLightClient.js"
export { createSeeder } from "./core/seeder/createSeeder.js"

// Convenience helpers
export { registerGracefulShutdown } from "./utils/gracefulShutdown.js"
export { uint8ArrayToHexString } from "./utils/codec.js"

// Default configs
export * from "./config/defaultConfig.js"

// Storage interfaces & adapters
export * from "./storage/interface.js"
export { UniversalStorageAdapter } from "./storage/adapters/UniversalStorageAdapter.js"
export { AccumulatorStorageAdapter } from "./storage/adapters/AccumulatorStorageAdapter.js"

// Ethereum types & helpers
export { EthereumAddress } from "./ethereum/EthereumAddress.js"
export { AccumulatorContract } from "./ethereum/AccumulatorContract.js"
export type { ChainBlock, BlockReference } from "./ethereum/events.types.js"

// IPFS types
export { CID } from "./ipfs/CID.js"
export { IpfsResolver } from "./ipfs/IpfsResolver.js"
export { IpfsPinner } from "./ipfs/IpfsPinner.js"

// Data managers & services
export { DataClient } from "./core/index.js"
export type { DataClientEvent } from "./core/dataClient/DataClient.js"
export type { ChainSnapshot, ChainRollback } from "./services/ChainState.js"
export { ChainChangedError } from "./services/ChainState.js"
export { EventCacheService } from "./services/EventCacheService.js"
export { PinningService } from "./services/PinningService.js"

// Types
export * from "./types/common.js"
export * from "./core/dataClient/DataClient.types.js"
export * from "./core/seeder/Seeder.types.js"
export * from "./core/lightClient/LightClient.types.js"
export * from "./ipfs/IpfsResolver.types.js"
export * from "./ipfs/IpfsPinner.types.js"
export * from "./ethereum/AccumulatorContract.types.js"
export * from "./services/EventCacheService.types.js"
