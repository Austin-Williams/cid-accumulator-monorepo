import { DeepPartial } from "../types/common"

export function mergeConfigWithDefaults<T>(userConfig: DeepPartial<T> | undefined, defaultConfig: T): T {
	const result: any = Array.isArray(defaultConfig) ? [] : {}

	for (const key in defaultConfig) {
		const userValue = userConfig?.[key as keyof T]
		const defaultValue = defaultConfig[key]

		if (
			userValue !== undefined &&
			userValue !== null &&
			typeof userValue === "object" &&
			!Array.isArray(userValue) &&
			typeof defaultValue === "object" &&
			!Array.isArray(defaultValue)
		) {
			// Recursively merge nested objects
			result[key] = mergeConfigWithDefaults(userValue, defaultValue)
		} else if (userValue !== undefined) {
			result[key] = userValue
		} else {
			result[key] = defaultValue
		}
	}
	return result as T
}
