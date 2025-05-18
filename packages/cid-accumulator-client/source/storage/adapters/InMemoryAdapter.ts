import type { Storage } from "../interface"

/**
 * InMemoryAdapter implements Storage using a native Map without any persistence.
 * Ideal for testing or ephemeral use cases where data doesn't need to be persisted.
 * No external dependencies required. Suitable for moderate datasets (~100k entries).
 */
export class InMemoryAdapter implements Storage {
	private store: Map<string, string> = new Map()

	constructor() {
		// No configuration needed for in-memory storage
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key.toLowerCase(), value)
	}

	async get(key: string): Promise<string | undefined> {
		return this.store.get(key.toLowerCase())
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key.toLowerCase())
	}

	async *iterate(prefix: string): AsyncIterable<{ key: string; value: string }> {
		for (const [key, value] of this.store.entries()) {
			if (key.startsWith(prefix.toLowerCase())) {
				yield { key, value }
			}
		}
	}

	async open(): Promise<void> {
		// Nothing to do for in-memory storage
	}

	async persist(): Promise<void> {
		// No persistence for in-memory storage
	}

	async close(): Promise<void> {
		// Clear the store when closing
		this.store.clear()
	}

	/**
	 * Utility method to clear all data from the store
	 */
	async clear(): Promise<void> {
		this.store.clear()
	}

	// Lifecycle functions
	async init(): Promise<void> {
		//noop
		return
	}

	async start(): Promise<void> {
		// noop
		return
	}

	stop(): void {
		this.close()
	}
}
