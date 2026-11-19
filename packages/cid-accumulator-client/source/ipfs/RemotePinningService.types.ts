import { RateLimiterOptions } from "../types/common.js"

export interface RemotePinningServiceConfig {
	serviceName?: string
	baseUrl?: string
	rateLimiterOptions?: RateLimiterOptions
}
