import type { RateLimiterOptions } from "../types/common"
import type { EthereumAddress } from "./EthereumAddress"
import type { DeepPartial } from "../types/common"

export interface AccumulatorContractConfigUserInput extends DeepPartial<AccumulatorContractConfig> { }

export interface AccumulatorContractConfig {
	accumulatorContractAddress: string | EthereumAddress
	ethereumHttpRpcUrl: string
	rateLimiterOptions: RateLimiterOptions
}
