import { RateLimiterOptions } from "../types/common.js"
import type { DeepPartial } from "../types/common.js"

export interface IpfsResolverConfigUserInput extends DeepPartial<IpfsResolverConfig> {}

export interface IpfsResolverConfig {
	gatewayUrl: string
	rateLimiterOptions: RateLimiterOptions
}
