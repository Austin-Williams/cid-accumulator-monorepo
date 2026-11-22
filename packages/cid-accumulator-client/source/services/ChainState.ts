import { EthereumAddress } from "../ethereum/EthereumAddress.js"
import type { AccumulatorContract } from "../ethereum/AccumulatorContract.js"
import type { ChainBlock } from "../ethereum/events.types.js"
import type { PeakWithHeight } from "../mmr/types.js"
import { CID } from "../ipfs/CID.js"
import type { Storage } from "../storage/interface.js"
import { getStorageCoordinator, type StorageCoordinator } from "../storage/coordination.js"
import { deleteLeafSuffix, getLeafPayloadFromDB } from "../storage/utils.js"
import { MerkleMountainRange } from "../mmr/MerkleMountainRange.js"
import { getRootCIDFromPeaks } from "../mmr/utils.js"

export interface ChainSnapshot {
	block: ChainBlock
	generation: number
}
export interface ChainSnapshotWithFinality extends ChainSnapshot {
	finalizedBlockNumber: number
}
export interface ChainRollback {
	account: EthereumAddress
	firstInvalidLeafIndex: number
	block: ChainBlock
	peaks: PeakWithHeight[]
}
export class ChainChangedError extends Error {
	constructor() {
		super("The chain changed during this operation; retry against the current tip")
	}
}
type AccountCheckpoint = { leafCount: number; lastInsertBlock: number }
type Recovery = {
	block: ChainBlock
	bootstrap: boolean
	accounts: Array<{ address: string; from: number; to: number; peaks: Array<{ cid: string; height: number }> }>
}

type SharedChainState = {
	address: string
	rollbackSubscribers: Set<(event: ChainRollback) => void>
	resetSubscribers: Set<() => void>
}

const chains = new WeakMap<StorageCoordinator, SharedChainState>()
export async function getChainState(storage: Storage, contract: AccumulatorContract): Promise<ChainState> {
	const coordinator = await getStorageCoordinator(storage)
	let shared = chains.get(coordinator)
	if (!shared) {
		shared = { address: contract.address.toString(), rollbackSubscribers: new Set(), resetSubscribers: new Set() }
		chains.set(coordinator, shared)
	} else if (shared.address !== contract.address.toString()) {
		throw new Error("Different accumulator contracts require separate storage scopes")
	}
	return new ChainState(storage, contract, coordinator, shared)
}

/** Shares recovery coordination and notifications while using this caller's storage and RPC provider. */
export class ChainState {
	constructor(
		private readonly storage: Storage,
		private readonly contract: AccumulatorContract,
		private readonly coordinator: StorageCoordinator,
		private readonly shared: SharedChainState
	) {}

	get generation(): number {
		return this.coordinator.generation
	}

	subscribeRollback(callback: (event: ChainRollback) => void): () => void {
		this.shared.rollbackSubscribers.add(callback)
		return () => {
			this.shared.rollbackSubscribers.delete(callback)
		}
	}
	subscribeReset(callback: () => void): () => void {
		this.shared.resetSubscribers.add(callback)
		return () => {
			this.shared.resetSubscribers.delete(callback)
		}
	}

	async snapshot(): Promise<ChainSnapshotWithFinality> {
		return this.coordinator.run(() => this.refresh())
	}

	async ensureCanonical(snapshot: ChainSnapshot): Promise<void> {
		await this.coordinator.run(async () => {
			if (snapshot.generation !== this.coordinator.generation) throw new ChainChangedError()
			let canonical: ChainBlock
			try {
				canonical = await this.contract.getBlock(snapshot.block.number)
			} catch {
				// A shorter replacement branch may no longer have this height.
				await this.refresh()
				throw new ChainChangedError()
			}
			if (canonical.hash !== snapshot.block.hash) {
				await this.refresh()
				throw new ChainChangedError()
			}
		})
	}

	/** Read the header belonging to this snapshot, even if the RPC tip moves during a log request. */
	async getBlock(snapshot: ChainSnapshot, number: number): Promise<ChainBlock> {
		return this.commit(snapshot, async () => {
			if (!Number.isSafeInteger(number) || number < 0 || number > snapshot.block.number) {
				throw new Error("Block is outside the captured chain snapshot")
			}
			const saved = await this.storage.get(`chain:block:${number}`)
			if (saved) return JSON.parse(saved) as ChainBlock
			const finalizedText = await this.storage.get("chain:finalized")
			if (!finalizedText || number > (JSON.parse(finalizedText) as ChainBlock).number) {
				throw new ChainChangedError()
			}
			return this.contract.getBlock(number)
		})
	}

	async commit<T>(snapshot: ChainSnapshot, operation: () => Promise<T>): Promise<T> {
		return this.coordinator.run(async () => {
			if (snapshot.generation !== this.coordinator.generation || (await this.storage.get("chain:recovery"))) {
				throw new ChainChangedError()
			}
			return operation()
		})
	}

	async read<T>(operation: () => Promise<T>): Promise<T> {
		return this.coordinator.run(async () => {
			if (await this.storage.get("chain:recovery")) await this.refresh()
			return operation()
		})
	}

	/** Called inside commit, before writing any account data. */
	async trackAccount(account: EthereumAddress, leafCount: number, lastInsertBlock: number): Promise<void> {
		const key = `chain:account:${account}`
		const saved = await this.storage.get(key)
		const previous: AccountCheckpoint = saved ? JSON.parse(saved) : { leafCount: 0, lastInsertBlock: 0 }
		await this.storage.put(
			key,
			JSON.stringify({
				leafCount: Math.max(previous.leafCount, leafCount),
				lastInsertBlock: Math.max(previous.lastInsertBlock, lastInsertBlock),
			})
		)
	}

	private async refresh(): Promise<ChainSnapshotWithFinality> {
		const latest = await this.contract.getBlock("latest")
		const headText = await this.storage.get("chain:head")
		const head: ChainBlock | undefined = headText ? JSON.parse(headText) : undefined
		const pending = await this.storage.get("chain:recovery")
		if (pending) {
			let recovery: Recovery = JSON.parse(pending)
			if (
				recovery.block.number > latest.number ||
				(await this.contract.getBlock(recovery.block.number)).hash !== recovery.block.hash
			) {
				const ancestor = head ? await this.commonAncestor(head, latest) : await this.contract.getBlock("finalized")
				recovery = await this.prepareRecovery(ancestor, recovery.bootstrap, recovery)
			}
			await this.recover(recovery)
		} else if (
			head &&
			(head.number > latest.number ||
				(head.hash !== latest.hash && (await this.contract.getBlock(head.number)).hash !== head.hash))
		) {
			await this.recover(await this.prepareRecovery(await this.commonAncestor(head, latest), false))
		} else if (!head) {
			// Payloads without a chain checkpoint need their canonical prefix validated once.
			await this.bootstrapAccounts()
			const finalized = await this.contract.getBlock("finalized")
			await this.recover(await this.prepareRecovery(finalized, true))
		}

		// Keep only the finalized checkpoint and the headers above it. Updates still use latest.
		const finalized = await this.contract.getBlock("finalized")
		const oldFinalizedText = await this.storage.get("chain:finalized")
		const oldFinalized: ChainBlock | undefined = oldFinalizedText ? JSON.parse(oldFinalizedText) : undefined
		if (oldFinalized) {
			if (
				finalized.number < oldFinalized.number ||
				(finalized.number === oldFinalized.number
					? finalized.hash !== oldFinalized.hash
					: (await this.contract.getBlock(oldFinalized.number)).hash !== oldFinalized.hash)
			) {
				throw new Error("RPC disagrees with the saved finalized checkpoint")
			}
		}
		const baselineText = await this.storage.get("chain:head")
		const baseline: ChainBlock | undefined = baselineText ? JSON.parse(baselineText) : undefined
		const snapshot = { block: latest, finalizedBlockNumber: finalized.number, generation: this.coordinator.generation }
		if (baseline?.hash === latest.hash && oldFinalized?.hash === finalized.hash) return snapshot
		// Do not overwrite saved ancestry until the complete candidate branch has been checked.
		const staged: ChainBlock[] = []
		const connectionHeight = Math.max(finalized.number, baseline?.number ?? finalized.number)
		for await (const block of this.branchAbove(latest, connectionHeight)) staged.push(block)
		const connectionHash = staged[staged.length - 1]?.parentHash ?? latest.hash
		if (baseline && baseline.number >= finalized.number) {
			if (connectionHash !== baseline.hash) throw new ChainChangedError()
			const checkpointText = await this.storage.get(`chain:block:${finalized.number}`)
			const checkpoint: ChainBlock | undefined =
				baseline.number === finalized.number ? baseline : checkpointText ? JSON.parse(checkpointText) : undefined
			if (checkpoint?.hash !== finalized.hash) throw new ChainChangedError()
		} else {
			if (connectionHash !== finalized.hash) throw new ChainChangedError()
			if (baseline && (await this.contract.getBlock(baseline.number)).hash !== baseline.hash)
				throw new ChainChangedError()
		}
		// Recheck before publishing a head assembled across multiple RPC requests.
		if ((await this.contract.getBlock(latest.number)).hash !== latest.hash) throw new ChainChangedError()
		for (const candidate of staged) await this.storage.put(`chain:block:${candidate.number}`, JSON.stringify(candidate))
		if (oldFinalized?.hash !== finalized.hash) {
			await this.storage.put(`chain:block:${finalized.number}`, JSON.stringify(finalized))
			await this.storage.put("chain:finalized", JSON.stringify(finalized))
		}
		await this.storage.put("chain:head", JSON.stringify(latest))
		for await (const { key } of this.storage.iterate("chain:block:")) {
			const number = Number(key.slice("chain:block:".length))
			if (number < finalized.number || number > latest.number) await this.storage.delete(key)
		}
		return snapshot
	}

	/** A pinned EVM call returns adjacent hashes for up to 256 parents at a time. */
	private async *branchAbove(head: ChainBlock, floor: number): AsyncGenerator<ChainBlock> {
		let { number, hash } = head
		let knownParent: string | undefined = head.parentHash
		while (number > floor) {
			const count = Math.min(number - floor, 256)
			let parents: string[]
			if (count === 1 && knownParent) {
				parents = [knownParent]
			} else {
				try {
					parents = await this.contract.getAncestorHashes({ number, hash }, count)
				} catch {
					// Some providers disable creation calls or prune historical EVM state.
					// Headers are still sufficient to follow this exact branch.
					let child = await this.contract.getBlockByHash(hash)
					if (child.number !== number || (knownParent && child.parentHash !== knownParent)) throw new ChainChangedError()
					while (child.number > floor) {
						yield child
						if (child.number === floor + 1) break
						const parent = await this.contract.getBlockByHash(child.parentHash)
						if (parent.number !== child.number - 1) throw new Error("Invalid parent block height")
						child = parent
					}
					return
				}
			}
			if (knownParent && parents[0] !== knownParent) throw new ChainChangedError()
			for (const parentHash of parents) {
				yield { number, hash, parentHash }
				hash = parentHash
				number--
			}
			knownParent = undefined
		}
	}

	private async commonAncestor(head: ChainBlock, latest: ChainBlock): Promise<ChainBlock> {
		const finalizedText = await this.storage.get("chain:finalized")
		const finalized: ChainBlock | undefined = finalizedText ? JSON.parse(finalizedText) : undefined
		const floor = finalized?.number ?? 0
		const tip = head.number < latest.number ? await this.contract.getBlock(head.number) : latest
		const savedTip = await this.storage.get(`chain:block:${tip.number}`)
		if (savedTip && tip.number >= floor && (JSON.parse(savedTip) as ChainBlock).hash === tip.hash) return tip
		if (tip.number === floor && tip.hash === finalized?.hash) return tip
		for await (const block of this.branchAbove(tip, floor)) {
			const saved = await this.storage.get(`chain:block:${block.number - 1}`)
			const parent: ChainBlock | undefined = saved ? JSON.parse(saved) : block.number - 1 === floor ? finalized : undefined
			if (parent && parent.hash === block.parentHash) return parent
		}
		throw new Error("No common ancestor above the finalized checkpoint")
	}

	private async bootstrapAccounts(): Promise<void> {
		const counts = new Map<string, number>()
		for await (const { key } of this.storage.iterate("account:")) {
			const match = key.match(/^account:(0x[0-9a-f]+):(?:leaf|leafIndex):(\d+)(?::|$)/)
			if (match) counts.set(match[1], Math.max(counts.get(match[1]) ?? 0, Number(match[2]) + 1))
		}
		for (const [address, leafCount] of counts) {
			await this.storage.put(
				`chain:account:${address}`,
				JSON.stringify({ leafCount, lastInsertBlock: Number.MAX_SAFE_INTEGER })
			)
		}
	}

	private async prepareRecovery(block: ChainBlock, bootstrap: boolean, previous?: Recovery): Promise<Recovery> {
		const accounts: Recovery["accounts"] = []
		const previousCounts = new Map(previous?.accounts.map((account) => [account.address, account.to]) ?? [])
		for await (const { key, value } of this.storage.iterate("chain:account:")) {
			const checkpoint: AccountCheckpoint = JSON.parse(value)
			if (!bootstrap && checkpoint.lastInsertBlock <= block.number) continue
			const address = key.slice("chain:account:".length)
			const account = EthereumAddress.fromString(address)
			const state = await this.contract.getCIDAccumulatorState({ blockHash: block.hash, requireCanonical: true })
			let from = state.meta.leafCount
			if (bootstrap && from > 0) {
				const mmr = new MerkleMountainRange()
				let complete = true
				for (let i = 0; i < from; i++) {
					const payload = await getLeafPayloadFromDB(this.storage, account, i)
					if (payload === undefined) {
						complete = false
						break
					}
					await mmr.addLeaf(i, payload)
				}
				const expected = await getRootCIDFromPeaks(state.peaks.map((peak) => peak.cid))
				const actual = await getRootCIDFromPeaks(mmr.peaks)
				if (!complete || !actual.equals(expected)) from = 0
			}
			accounts.push({
				address,
				from,
				to: Math.max(checkpoint.leafCount, previousCounts.get(address) ?? 0),
				peaks: from === 0 ? [] : state.peaks.map((p) => ({ cid: p.cid.toString(), height: p.height })),
			})
		}
		const recovery = { block, bootstrap, accounts }
		await this.storage.put("chain:recovery", JSON.stringify(recovery))
		return recovery
	}

	private async recover(recovery: Recovery): Promise<void> {
		this.coordinator.generation++
		for (const callback of this.shared.resetSubscribers) {
			try {
				callback()
			} catch (error) {
				console.error(error)
			}
		}
		for (const account of recovery.accounts) {
			await deleteLeafSuffix(this.storage, EthereumAddress.fromString(account.address), account.from, account.to)
			await this.storage.put(
				`chain:account:${account.address}`,
				JSON.stringify({ leafCount: Math.min(account.from, account.to), lastInsertBlock: recovery.block.number })
			)
		}
		for await (const { key } of this.storage.iterate("events:")) {
			const match = key.match(/:block:(\d+)$/)
			if (recovery.bootstrap || (match && Number(match[1]) > recovery.block.number)) await this.storage.delete(key)
		}
		const cursor = await this.storage.get("events:latestPolledBlock")
		if (cursor !== undefined)
			await this.storage.put("events:latestPolledBlock", String(Math.min(Number(cursor), recovery.block.number)))
		if ((await this.contract.getBlock(recovery.block.number)).hash !== recovery.block.hash)
			throw new ChainChangedError()
		await this.storage.put("chain:head", JSON.stringify(recovery.block))
		await this.storage.delete("chain:recovery")
		for (const callback of this.shared.resetSubscribers) {
			try {
				callback()
			} catch (error) {
				console.error(error)
			}
		}
		for (const account of recovery.accounts) {
			if (account.from >= account.to) continue
			const event: ChainRollback = {
				account: EthereumAddress.fromString(account.address),
				firstInvalidLeafIndex: account.from,
				block: recovery.block,
				peaks: account.peaks.map((p) => ({ cid: CID.parse(p.cid), height: p.height })),
			}
			for (const callback of this.shared.rollbackSubscribers) {
				try {
					callback(event)
				} catch (error) {
					console.error(error)
				}
			}
		}
	}
}
