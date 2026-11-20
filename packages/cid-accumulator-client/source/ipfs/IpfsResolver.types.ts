import { RateLimiterOptions } from "../types/common.js"
import type { DeepPartial } from "../types/common.js"

export type IpfsResolverConfigUserInput = DeepPartial<IpfsResolverConfig>

export interface IpfsResolverConfig {
	gatewayUrl: string
	rateLimiterOptions: RateLimiterOptions
}
