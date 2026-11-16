import type { EthereumAddress } from "../ethereum/EthereumAddress.js"
import type { DeepPartial } from "../types/common.js"

export interface EventCacheServiceConfigUserInput extends DeepPartial<EventCacheServiceConfig> {}

export interface EventCacheServiceConfig {
	lazyLoadEvents: boolean
	pollingIntervalMs: number
	/**
	 * Leave empty to monitor all accounts
	 */
	specificAccountsOnly: EthereumAddress[]
}
