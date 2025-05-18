// envDetection.ts: Utility to detect runtime environment

export function isBrowser(): boolean {
	return typeof window !== "undefined" && typeof window.document !== "undefined"
}

export function isNodeJs(): boolean {
	return typeof process !== "undefined" && !!(process.versions && process.versions.node)
}
