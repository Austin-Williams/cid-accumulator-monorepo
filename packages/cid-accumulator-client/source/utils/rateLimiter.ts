import type { Logger, RateLimiterOptions } from "../types/common.js"
import { createLogger } from "./logging.js"
/**
 * A FIFO rate limiter that ensures requests are processed in order
 * with configurable retry logic and exponential backoff.
 */

/**
 * Retries an async function with full-jitter exponential backoff.
 * @param fn - Operation to retry
 * @param maxRetries - Maximum retries after the initial attempt; 0 disables retries
 * @param baseDelay - Base delay in milliseconds for backoff
 * @param capDelay - Maximum backoff cap in milliseconds
 * @returns A promise that resolves with the result of the function
 * @throws The last error encountered if all retries fail
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	maxRetries = 3,
	baseDelay = 500,
	capDelay = 10000
): Promise<T> {
	let attempt = 0
	while (true) {
		try {
			return await fn()
		} catch (err) {
			attempt++
			if (attempt > maxRetries) throw err
			const backoff = Math.min(capDelay, baseDelay * 2 ** (attempt - 1))
			const delay = Math.random() * backoff
			await new Promise((res) => setTimeout(res, delay))
		}
	}
}

/**
 * Task to be processed in the queue
 * @template T The return type of the task function
 */
type QueueTask<T> = {
	/** Unique identifier for the task */
	id: number
	/** The function to execute */
	fn: () => Promise<T>
	/** Function to call on successful completion */
	resolve: (value: T | PromiseLike<T>) => void
	/** Function to call on failure */
	reject: (reason?: any) => void
}

/**
 * A rate limiter with a FIFO queue that ensures requests are processed in order
 * @remarks
 * This class implements a rate limiter that processes tasks sequentially with a
 * configurable delay between tasks. It also supports automatic retries with
 * exponential backoff for failed operations.
 */
export class RateLimiter {
	private intervalMs: number
	private maxRetries: number
	private baseDelay: number
	private capDelay: number
	private logger: Logger = createLogger("RateLimiter")
	/** Queue of pending tasks */
	private queue: Array<QueueTask<any>> = []

	/** Flag indicating if the queue processor is running */
	private processingQueue = false

	/** Counter for assigning unique task IDs */
	private taskCounter = 0

	/**
	 * Creates a new rate limiter
	 * @param params - Configuration parameters
	 */
	constructor(params: RateLimiterOptions) {
		this.intervalMs = params.intervalMs
		this.maxRetries = params.maxRetries
		this.baseDelay = params.baseDelay
		this.capDelay = params.capDelay
	}

	/**
	 * Executes a function with rate limiting
	 * @template T The return type of the function
	 * @param fn - The function to execute with rate limiting
	 * @returns A promise that resolves with the result of the function
	 */
	public execute<T>(fn: () => Promise<T>): Promise<T> {
		const id = ++this.taskCounter
		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				id,
				fn,
				resolve,
				reject,
			})
			if (!this.processingQueue) {
				this.processingQueue = true
				this.processQueue()
			}
		})
	}

	/**
	 * Gets the current length of the task queue
	 * @returns The number of tasks waiting to be processed
	 */
	public getQueueLength(): number {
		return this.queue.length
	}

	/**
	 * Clears all pending tasks in the queue
	 * @param rejectPending - Whether to reject pending tasks with an error (default: true)
	 */
	public clearQueue(rejectPending = true): void {
		if (rejectPending) {
			const error = new Error("Task cancelled: queue cleared")
			this.queue.forEach((task) => task.reject(error))
		}
		this.queue = []
	}

	/**
	 * Processes the next task in the queue
	 * @private
	 */
	private processQueue(): void {
		const task = this.queue.shift()
		if (!task) {
			this.processingQueue = false
			return
		}

		retryWithBackoff(task.fn, this.maxRetries, this.baseDelay, this.capDelay)
			.then((result) => task.resolve(result))
			.catch((error) => {
				this.logger.error(`Task ${task.id} failed: ${error}`)
				task.reject(error)
			})
			.finally(() => {
				setTimeout(() => this.processQueue(), this.intervalMs)
			})
	}
}
