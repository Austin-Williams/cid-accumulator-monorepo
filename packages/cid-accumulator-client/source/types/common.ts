export interface Logger {
	/**
	 * Log an informational message
	 * @param message - The message to log
	 */
	log: (message: string) => void

	/**
	 * Log an error message
	 * @param message - The error message to log
	 */
	error: (message: string) => void

	/**
	 * Log a warning message
	 * @param message - The warning message to log
	 */
	warn: (message: string) => void
}

export interface RateLimiterOptions {
	intervalMs: number
	/** Maximum retries after the initial attempt; 0 disables retries. */
	maxRetries: number
	baseDelay: number
	capDelay: number
}

export interface LifecycleComponent {
	init(): Promise<void>
	start(): Promise<void>
	stop(): void
}

export type DeepPartial<T> = {
	[P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}
