import { RateLimiterOptions } from "../types/common"

export interface RemotePinningServiceConfig {
	serviceName?: string
	baseUrl?: string
	rateLimiterOptions?: RateLimiterOptions
}

/**
 * Result of a remote pinning operation
 */
export interface RemotePinningResult {
	success: boolean
	skipService: boolean
}

/**
 * Result of checking if an IPFS error is non-retriable
 */
export interface IpfsErrorCheckResult {
	isNonRetriable: boolean
	errorType: string
}
