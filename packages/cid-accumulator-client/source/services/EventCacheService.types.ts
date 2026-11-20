import type { DeepPartial } from "../types/common.js"

export type EventCacheServiceConfigUserInput = DeepPartial<EventCacheServiceConfig>

export interface EventCacheServiceConfig {
	lazyLoadEvents: boolean
	pollingIntervalMs: number
}
