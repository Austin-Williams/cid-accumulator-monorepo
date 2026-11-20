/// <reference lib="es2021.weakref" />

import type { Storage } from "../interface.js"

type SharedDatabase = {
	filePath: string
	store: Map<string, string>
	pendingWrite: Promise<void>
	loadPromise?: Promise<void>
}

// Adapters in this process share state by normalized absolute path. Weak references
// let the data be collected once no adapters or pending operations use it.
const databases = new Map<string, WeakRef<SharedDatabase>>()

// JSMapAdapter implements Storage using a native Map,
// with persistence to a local file (JSON-serialized).
// No external dependencies required. Suitable for moderate datasets (~100k entries).
export class JSMapAdapter implements Storage {
	private readonly filePath: string
	private databasePromise?: Promise<SharedDatabase>

	constructor(filePath: string | undefined) {
		this.filePath = filePath ?? "./db/cid-accumulator.json"
	}

	async getIdentity(): Promise<object> {
		return this.getDatabase()
	}

	async put(key: string, value: string): Promise<void> {
		const database = await this.getDatabase()
		database.store.set(key.toLowerCase(), value)
		await this.persistDatabase(database)
	}

	async get(key: string): Promise<string | undefined> {
		const database = await this.getDatabase()
		return database.store.get(key.toLowerCase())
	}

	async delete(key: string): Promise<void> {
		const database = await this.getDatabase()
		database.store.delete(key.toLowerCase())
		await this.persistDatabase(database)
	}

	async *iterate(prefix: string): AsyncIterable<{ key: string; value: string }> {
		const database = await this.getDatabase()
		for (const [key, value] of database.store.entries()) {
			if (key.startsWith(prefix.toLowerCase())) {
				yield { key, value }
			}
		}
	}

	async open(): Promise<void> {
		await this.getDatabase()
	}

	private async getDatabase(): Promise<SharedDatabase> {
		const acquisition = (this.databasePromise ??= this.acquireDatabase())
		try {
			return await acquisition
		} catch (error) {
			// A failed initial read must be retryable after the underlying file is repaired.
			if (this.databasePromise === acquisition) this.databasePromise = undefined
			throw error
		}
	}

	private async acquireDatabase(): Promise<SharedDatabase> {
		// Keep Node built-ins lazy: this module is also imported by browser bundles.
		const { resolve } = await import("path")
		const filePath = resolve(this.filePath)
		for (const [key, reference] of databases) {
			if (!reference.deref()) databases.delete(key)
		}
		const database: SharedDatabase = databases.get(filePath)?.deref() ?? {
			filePath,
			store: new Map(),
			pendingWrite: Promise.resolve(),
		}
		databases.set(filePath, new WeakRef(database))
		if (!database.loadPromise) {
			database.loadPromise = this.loadDatabase(database).catch((error) => {
				database.loadPromise = undefined
				throw error
			})
		}
		await database.loadPromise
		return database
	}

	private async loadDatabase(database: SharedDatabase): Promise<void> {
		const { promises: fs } = await import("fs")
		// Load once before any adapter mutates the shared store.
		try {
			const data = await fs.readFile(database.filePath, "utf8")
			const obj = JSON.parse(data)
			database.store = new Map(Object.entries(obj))
		} catch (err) {
			if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) throw err
		}
	}

	async persist(): Promise<void> {
		const database = await this.getDatabase()
		await this.persistDatabase(database)
	}

	private persistDatabase(database: SharedDatabase): Promise<void> {
		const write = database.pendingWrite.then(() => this.writeSnapshot(database))
		// Report failures to this caller without blocking later writes or retries.
		database.pendingWrite = write.catch(() => {})
		return write
	}

	private async writeSnapshot(database: SharedDatabase): Promise<void> {
		const { promises: fs } = await import("fs")
		const { dirname } = await import("path")
		const { randomUUID } = await import("crypto")
		// Capture the current state when this queued write starts.
		const snapshot = JSON.stringify(Object.fromEntries(database.store))
		await fs.mkdir(dirname(database.filePath), { recursive: true })

		// Keep the temporary file on the same filesystem for atomic replacement.
		const temporaryPath = `${database.filePath}.${randomUUID()}.tmp`
		const file = await fs.open(temporaryPath, "wx", 0o600)
		try {
			try {
				await fs.writeFile(file, snapshot, "utf8")
			} finally {
				await file.close()
			}
			await fs.rename(temporaryPath, database.filePath)
		} finally {
			await fs.rm(temporaryPath, { force: true })
		}
	}

	async close(): Promise<void> {
		// Flush earlier writes without discarding state still used by this adapter or its peers.
		await this.persist()
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
		// Fire off persist without blocking (no guarantee of success, but we try)
		this.persist().catch((err) => {
			console.error(`Failed to persist JSMapAdapter data: ${err}`)
		})
	}
}
