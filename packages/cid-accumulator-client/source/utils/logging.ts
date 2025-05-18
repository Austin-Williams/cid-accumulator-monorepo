import type { Logger } from "../types/common"
/**
 * Logging utility functions
 */

// ANSI color codes for console output
const colors = {
	reset: "\x1b[0m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	green: "\x1b[32m"
}

/**
 * Creates a logger with a consistent prefix format and colored output
 * @param prefix - The prefix to add to all log messages
 * @returns An object with log, error, and warn methods
 */
export function createLogger(prefix: string): Logger {
	return {
		/**
		 * Log an informational message
		 * @param message - The message to log
		 */
		log: (message: string) => console.log(`[${prefix}] ${message}`),

		/**
		 * Log an error message (red text)
		 * @param message - The error message to log
		 */
		error: (message: string) => console.error(`${colors.red}[${prefix}] ${message}${colors.reset}`),

		/**
		 * Log a warning message (yellow text)
		 * @param message - The warning message to log
		 */
		warn: (message: string) => console.warn(`${colors.yellow}[${prefix}] ${message}${colors.reset}`),
	}
}
