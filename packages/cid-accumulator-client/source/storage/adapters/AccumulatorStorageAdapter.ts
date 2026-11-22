import type { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import type { Storage } from "../interface.js"

const identities = new WeakMap<object, Map<string, object>>()

/** Isolates chain state and cached records by chain ID and consumer contract. */
export class AccumulatorStorageAdapter implements Storage {
	private prefix?: Promise<string>
	private chainId?: bigint

	constructor(private readonly storage: Storage, private readonly contract: AccumulatorContract) {}

	/** Remember where a live client keeps its indexed payloads. Startup may only use
	 * this hint after checking the actual payloads against the freshly read contract root. */
	async rememberPayloadCache(): Promise<void> {
		await this.storage.put(`lastPayloadScope:${this.contract.address}`, await this.getPrefix())
	}

	async *payloadCaches(count: number): AsyncGenerator<AsyncIterable<string>> {
		const account = `account:${this.contract.address}:leaf:`
		const tipKey = account + (count - 1) + ":payload"
		const hint = await this.storage.get(`lastPayloadScope:${this.contract.address}`)
		if (hint && /^chain:\d+:accumulator:0x[0-9a-f]{40}:$/.test(hint) && hint.endsWith(`:accumulator:${this.contract.address}:`)) {
			if (await this.storage.get(hint + tipKey) !== undefined) yield this.readPayloads(hint + account, count)
			return
		}
		// Older databases have no scope hint. Only consider namespaces containing this tip.
		const suffix = `:accumulator:${this.contract.address}:${tipKey}`
		for await (const { key } of this.storage.iterate("chain:")) {
			if (key.endsWith(suffix)) yield this.readPayloads(key.slice(0, -tipKey.length) + account, count)
		}
	}

	private async *readPayloads(prefix: string, count: number): AsyncGenerator<string> {
		for (let i = 0; i < count; i++) {
			const payload = await this.storage.get(prefix + i + ":payload")
			if (payload === undefined || !/^(?:[a-f\d]{2})*$/i.test(payload)) return
			yield payload.toLowerCase()
		}
	}

	private getPrefix(): Promise<string> {
		this.prefix ??= this.contract.getChainId().then(chainId => {
			if (this.chainId !== undefined && this.chainId !== chainId) {
				throw new Error("RPC chain ID changed; create a new client for this chain")
			}
			this.chainId = chainId
			return `chain:${chainId}:accumulator:${this.contract.address}:`
		}).catch(error => {
			this.prefix = undefined
			throw error
		})
		return this.prefix
	}

	async getIdentity(): Promise<object> {
		const prefix = await this.getPrefix()
		const underlying = this.storage.getIdentity ? await this.storage.getIdentity() : this.storage
		let scopes = identities.get(underlying)
		if (!scopes) {
			scopes = new Map()
			identities.set(underlying, scopes)
		}
		let identity = scopes.get(prefix)
		if (!identity) {
			identity = {}
			scopes.set(prefix, identity)
		}
		return identity
	}

	async put(key: string, value: string): Promise<void> { return this.storage.put(await this.getPrefix() + key, value) }
	async get(key: string): Promise<string | undefined> { return this.storage.get(await this.getPrefix() + key) }
	async delete(key: string): Promise<void> { return this.storage.delete(await this.getPrefix() + key) }
	async *iterate(keyPrefix: string): AsyncIterable<{ key: string; value: string }> {
		const prefix = await this.getPrefix()
		for await (const { key, value } of this.storage.iterate(prefix + keyPrefix)) {
			yield { key: key.slice(prefix.length), value }
		}
	}
	async open(): Promise<void> { await this.getPrefix(); await this.storage.open() }
	async close(): Promise<void> { await this.storage.close(); this.prefix = undefined }
	persist(): Promise<void> { return this.storage.persist() }
	async init(): Promise<void> { await this.storage.init() }
	async start(): Promise<void> { await this.storage.start() }
	stop(): void { this.prefix = undefined; this.storage.stop() }
}
