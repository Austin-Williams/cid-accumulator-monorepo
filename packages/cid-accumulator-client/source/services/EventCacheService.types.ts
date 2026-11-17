import type { DeepPartial } from "../types/common.js"

export interface EventCacheServiceConfigUserInput extends DeepPartial<EventCacheServiceConfig> {}

export interface EventCacheServiceConfig {
	lazyLoadEvents: boolean
	pollingIntervalMs: number
}
