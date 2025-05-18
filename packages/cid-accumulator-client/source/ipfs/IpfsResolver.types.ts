import { RateLimiterOptions } from "../types/common"
import type { DeepPartial } from "../types/common"

export interface IpfsResolverConfigUserInput extends DeepPartial<IpfsResolverConfig> {}

export interface IpfsResolverConfig {
	gatewayUrl: string
	rateLimiterOptions: RateLimiterOptions
}
