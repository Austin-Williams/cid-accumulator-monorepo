import { RateLimiterOptions } from "../types/common.js"

export interface IpfsPinnerConfig {
	baseUrl?: string
	remotePin?: boolean
	remotePinningServiceRateLimiterOptions?: RateLimiterOptions
}
