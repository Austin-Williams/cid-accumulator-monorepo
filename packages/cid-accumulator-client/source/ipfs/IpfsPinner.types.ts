import { RateLimiterOptions } from "../types/common"

export interface IpfsPinnerConfig {
	baseUrl?: string
	remotePin?: boolean
	remotePinningServiceRateLimiterOptions?: RateLimiterOptions
}
