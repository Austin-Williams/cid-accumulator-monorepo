import type { RateLimiterOptions } from "../types/common.js"
import type { EthereumAddress } from "./EthereumAddress.js"
import type { DeepPartial } from "../types/common.js"

export interface AccumulatorContractConfigUserInput extends DeepPartial<AccumulatorContractConfig> { }

export interface AccumulatorContractConfig {
	accumulatorContractAddress: string | EthereumAddress
	ethereumHttpRpcUrl: string
	rateLimiterOptions: RateLimiterOptions
}
