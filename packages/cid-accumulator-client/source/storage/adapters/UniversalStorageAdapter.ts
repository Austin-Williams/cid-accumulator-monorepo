import { Storage } from "../interface"
import { IndexedDBAdapter } from "./IndexedDBAdapter"
import { JSMapAdapter } from "./JSMapAdapter"
import { isBrowser } from "../../utils/envDetection"

export class UniversalStorageAdapter implements Storage {
	private backend: Storage

	constructor(dbPath?: string) {
		if (isBrowser()) {
			this.backend = new IndexedDBAdapter()
		} else {
			this.backend = new JSMapAdapter(dbPath)
		}
	}

	async put(key: string, value: any) {
		return this.backend.put(key, value)
	}
	async get(key: string) {
		return this.backend.get(key)
	}
	async delete(key: string) {
		return this.backend.delete(key)
	}
	async open() {
		return this.backend.open()
	}
	async close() {
		return this.backend.close()
	}
	async persist() {
		return this.backend.persist()
	}
	iterate(keyPrefix: string): AsyncIterable<{ key: string; value: string }> {
		const backend = this.backend
		return {
			async *[Symbol.asyncIterator]() {
				const iterable = backend.iterate(keyPrefix)
				for await (const item of iterable) {
					yield item
				}
			},
		}
	}

	// Lifecycle functions
	async init(): Promise<void> {
		await this.backend.init()
	}

	async start(): Promise<void> {
		await this.backend.start()
		return
	}

	stop(): void {
		this.backend.stop()
		return
	}
}
