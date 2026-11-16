import type { DeepPartial } from "../types/common.js"

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

export function mergeConfigWithDefaults<T>(userConfig: DeepPartial<T> | undefined, defaultConfig: T): T {
	const result: any = Array.isArray(defaultConfig) ? [] : {}

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
