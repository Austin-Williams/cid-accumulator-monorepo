import { createLogger } from "../../utils/logging.js"

import type { Logger } from "../../types/common.js"
import type { Storage } from "../interface.js"

export class IndexedDBAdapter implements Storage {
	private _instanceId: number
	private static _nextId = 1
	private dbName: string
	private storeName: string
	private dbPromise: Promise<IDBDatabase>
	private logger: Logger

	constructor(dbName = "cid-accumulator", storeName = "kv") {
		this._instanceId = IndexedDBAdapter._nextId++
		this.dbName = dbName
		this.storeName = storeName
		this.dbPromise = this.openDB()
		this.logger = createLogger("IndexedDBAdapter")
	}

	private openDB(): Promise<IDBDatabase> {
		if (typeof indexedDB === "undefined") throw new Error("IndexedDB is not available in this environment.")
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(this.dbName, 1)
			req.onupgradeneeded = () => {
				req.result.createObjectStore(this.storeName)
			}
			req.onsuccess = () => {
				resolve(req.result)
			}
			req.onerror = () => {
				this.logger.error(`onerror (instanceId=${this._instanceId}): ${req.error}`)
				reject(req.error)
			}
		})
	}

	private async withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
		const db = await this.dbPromise
		return new Promise<T>((resolve, reject) => {
			const tx = db.transaction(this.storeName, mode)
			const store = tx.objectStore(this.storeName)
			const req = fn(store)
			// A successful request can still be rolled back before the transaction commits.
			tx.oncomplete = () => resolve(req.result as T)
			tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
			req.onerror = () => reject(req.error)
		})
	}

	async get(key: string): Promise<string | undefined> {
		return await this.withStore("readonly", (store) => store.get(key.toLowerCase()))
	}

	async put(key: string, value: string): Promise<void> {
		await this.withStore("readwrite", (store) => store.put(value, key.toLowerCase()))
	}

	async delete(key: string): Promise<void> {
		await this.withStore("readwrite", (store) => store.delete(key.toLowerCase()))
	}

	async *iterate(prefix: string): AsyncIterable<{ key: string; value: string }> {
		const db = await this.dbPromise
		if (!db) throw new Error("IndexedDB database not initialized.")
		const tx = db.transaction(this.storeName, "readonly")
		const store = tx.objectStore(this.storeName)
		const req = store.openCursor()
		// Wrap cursor iteration in a promise to collect results, then yield
		const results: { key: string; value: string }[] = await new Promise((resolve, reject) => {
			const out: { key: string; value: string }[] = []
			tx.oncomplete = () => resolve(out)
			tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
			req.onsuccess = () => {
				const cursor = req.result as IDBCursorWithValue | null
				if (cursor) {
					if (typeof cursor.key === "string" && cursor.key.startsWith(prefix.toLowerCase())) {
						out.push({ key: cursor.key, value: cursor.value })
					}
					cursor.continue()
				}
			}
			req.onerror = () => reject(req.error)
		})
		for (const item of results) {
			yield item
		}
	}

	async open(): Promise<void> {
		await this.dbPromise
	}

	async persist(): Promise<void> {
		// No-op for IndexedDB, auto-persistent
	}

	async close(): Promise<void> {
		// IndexedDB does not require explicit close
	}

	// Lifecycle functions
	async init(): Promise<void> {
		await this.open()
	}

	async start(): Promise<void> {
		// noop
		return
	}

	stop(): void {
		// noop
		return
	}
}
