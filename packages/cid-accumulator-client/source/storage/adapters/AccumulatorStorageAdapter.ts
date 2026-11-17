import type { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import type { Storage } from "../interface.js"

const identities = new WeakMap<object, Map<string, object>>()

/** Isolates chain state and cached records by chain ID and consumer contract. */
export class AccumulatorStorageAdapter implements Storage {
	private prefix?: Promise<string>
	private chainId?: bigint

	constructor(private readonly storage: Storage, private readonly contract: AccumulatorContract) {}

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
	async init(): Promise<void> { await this.getPrefix(); await this.storage.init() }
	async start(): Promise<void> { await this.getPrefix(); await this.storage.start() }
	stop(): void { this.prefix = undefined; this.storage.stop() }
}
