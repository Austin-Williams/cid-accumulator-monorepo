import type { Storage } from "../interface"

// JSMapAdapter implements Storage using a native Map,
// with persistence to a local file (JSON-serialized).
// No external dependencies required. Suitable for moderate datasets (~100k entries).
export class JSMapAdapter implements Storage {
	private store: Map<string, string> = new Map()
	private filePath: string

	constructor(filePath: string | undefined) {
		this.filePath = filePath ?? "./db/cid-accumulator.json"
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key.toLowerCase(), value)
		await this.persist()
	}

	async get(key: string): Promise<string | undefined> {
		return this.store.get(key.toLowerCase())
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key.toLowerCase())
		await this.persist()
	}

	async *iterate(prefix: string): AsyncIterable<{ key: string; value: string }> {
		for (const [key, value] of this.store.entries()) {
			if (key.startsWith(prefix.toLowerCase())) {
				yield { key, value }
			}
		}
	}

	async open(): Promise<void> {
		const { promises: fs } = await import("fs")
		// Load from disk if file exists
		try {
			const data = await fs.readFile(this.filePath, "utf8")
			const obj = JSON.parse(data)
			this.store = new Map(Object.entries(obj))
		} catch (err: any) {
			if (err.code !== "ENOENT") throw err // Ignore file-not-found
		}
	}

	async persist(): Promise<void> {
		const { promises: fs } = await import("fs")
		const obj: Record<string, string> = Object.fromEntries(this.store)
		// Ensure the directory exists before writing the file
		const { dirname } = await import("path")
		await fs.mkdir(dirname(this.filePath), { recursive: true })
		await fs.writeFile(this.filePath, JSON.stringify(obj), "utf8")
	}

	async close(): Promise<void> {
		// Persist to disk as JSON (for compatibility)
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
