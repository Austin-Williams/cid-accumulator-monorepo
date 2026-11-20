import type { DeepPartial } from "../types/common.js"
import { isPlainObject } from "./objects.js"

export function mergeConfigWithDefaults<T>(userConfig: DeepPartial<T> | undefined, defaultConfig: T): T {
	const result = (Array.isArray(defaultConfig) ? [] : {}) as Record<string, unknown>

	for (const key in defaultConfig) {
		const userValue = userConfig?.[key as keyof T]
		const defaultValue = defaultConfig[key]

		if (isPlainObject(userValue) && isPlainObject(defaultValue)) {
			// Merge nested configuration records, preserving class instances as complete values.
			result[key] = mergeConfigWithDefaults<Record<string, unknown>>(userValue, defaultValue)
		} else if (userValue !== undefined) {
			result[key] = userValue
		} else {
			result[key] = defaultValue
		}
	}
	return result as T
}
