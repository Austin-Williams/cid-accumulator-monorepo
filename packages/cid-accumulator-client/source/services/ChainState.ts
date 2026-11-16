import { EthereumAddress } from "../ethereum/EthereumAddress.js"
import type { AccumulatorContract } from "../ethereum/AccumulatorContract.js"
import type { ChainBlock } from "../ethereum/events.types.js"
import type { PeakWithHeight } from "../mmr/types.js"
import { CID } from "../ipfs/CID.js"
import type { Storage } from "../storage/interface.js"
import { getStorageCoordinator, type StorageCoordinator } from "../storage/coordination.js"
import { deleteLeafSuffix, getLeafRecordFromDB } from "../storage/utils.js"
import { MerkleMountainRange } from "../mmr/MerkleMountainRange.js"
import { getRootCIDFromPeaks } from "../mmr/utils.js"

export interface ChainSnapshot {
	block: ChainBlock
	generation: number
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
	legacy: boolean
	accounts: Array<{ address: string; from: number; to: number; peaks: Array<{ cid: string; height: number }> }>
	registryAccounts: string[]
	removedRegistryAccounts: string[]
}

const chains = new WeakMap<StorageCoordinator, ChainState>()
export async function getChainState(storage: Storage, contract: AccumulatorContract): Promise<ChainState> {
	const coordinator = await getStorageCoordinator(storage)
	let chain = chains.get(coordinator)
	if (!chain) {
		chain = new ChainState(storage, contract, coordinator)
		chains.set(coordinator, chain)
	}
	return chain
}

/** One recovery/write gate for every service sharing this database in this process. */
export class ChainState {
	private rollbackSubscribers = new Set<(event: ChainRollback) => void>()
	private resetSubscribers = new Set<() => void>()
	constructor(
		private storage: Storage,
		private contract: AccumulatorContract,
		private coordinator: StorageCoordinator
	) {}

	get generation(): number {
		return this.coordinator.generation
	}

	subscribeRollback(callback: (event: ChainRollback) => void): () => void {
		this.rollbackSubscribers.add(callback)
		return () => {
			this.rollbackSubscribers.delete(callback)
		}
	}
	subscribeReset(callback: () => void): () => void {
		this.resetSubscribers.add(callback)
		return () => {
			this.resetSubscribers.delete(callback)
		}
	}

	async snapshot(): Promise<ChainSnapshot> {
		return this.coordinator.run(async () => {
			await this.refresh()
			return { block: JSON.parse((await this.storage.get("chain:head"))!), generation: this.coordinator.generation }
		})
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

	private async refresh(): Promise<void> {
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
				recovery = await this.prepareRecovery(ancestor, recovery.legacy, recovery)
			}
			await this.recover(recovery)
		} else if (
			head &&
			(head.number > latest.number ||
				(head.hash !== latest.hash && (await this.contract.getBlock(head.number)).hash !== head.hash))
		) {
			await this.recover(await this.prepareRecovery(await this.commonAncestor(head, latest), false))
		} else if (!head) {
			// Old numeric cursors prove no branch identity. Validate their payload prefix once.
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
		if (baseline?.hash === latest.hash && oldFinalized?.hash === finalized.hash) return
		// Do not overwrite saved ancestry until the complete candidate branch has been checked.
		const staged: ChainBlock[] = []
		let block = latest
		const connectionHeight = Math.max(finalized.number, baseline?.number ?? finalized.number)
		while (block.number > connectionHeight) {
			staged.push(block)
			const parent = await this.contract.getBlockByHash(block.parentHash)
			if (parent.number !== block.number - 1) throw new Error("Invalid parent block height")
			block = parent
		}
		if (baseline && baseline.number >= finalized.number) {
			if (block.hash !== baseline.hash) throw new ChainChangedError()
			const checkpointText = await this.storage.get(`chain:block:${finalized.number}`)
			const checkpoint: ChainBlock | undefined =
				baseline.number === finalized.number ? baseline : checkpointText ? JSON.parse(checkpointText) : undefined
			if (checkpoint?.hash !== finalized.hash) throw new ChainChangedError()
		} else {
			if (block.hash !== finalized.hash) throw new ChainChangedError()
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
	}

	private async commonAncestor(head: ChainBlock, latest: ChainBlock): Promise<ChainBlock> {
		const finalizedText = await this.storage.get("chain:finalized")
		const floor = finalizedText ? (JSON.parse(finalizedText) as ChainBlock).number : 0
		for (let number = Math.min(head.number, latest.number); number >= floor; number--) {
			const saved = await this.storage.get(`chain:block:${number}`)
			if (!saved) continue
			const canonical = await this.contract.getBlock(number)
			if (canonical.hash === (JSON.parse(saved) as ChainBlock).hash) return canonical
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

	private async prepareRecovery(block: ChainBlock, legacy: boolean, previous?: Recovery): Promise<Recovery> {
		const accounts: Recovery["accounts"] = []
		const previousCounts = new Map(previous?.accounts.map((account) => [account.address, account.to]) ?? [])
		const birthday = await this.contract.getSingletonBirthdayBlockNum()
		for await (const { key, value } of this.storage.iterate("chain:account:")) {
			const checkpoint: AccountCheckpoint = JSON.parse(value)
			if (!legacy && checkpoint.lastInsertBlock <= block.number) continue
			const address = key.slice("chain:account:".length)
			const account = EthereumAddress.fromString(address)
			const state =
				block.number < birthday
					? { meta: { leafCount: 0 }, peaks: [] }
					: await this.contract.getState(account, { blockHash: block.hash, requireCanonical: true })
			let from = state.meta.leafCount
			if (legacy && from > 0) {
				const mmr = new MerkleMountainRange()
				let complete = true
				for (let i = 0; i < from; i++) {
					const record = await getLeafRecordFromDB(this.storage, account, i)
					if (!record) {
						complete = false
						break
					}
					await mmr.addLeafWithTrail(i, record.payload)
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
		// Persist the complete registry rewrite before deleting any entries. A retry must
		// retain accounts whose old numeric keys were already removed by an interrupted run.
		const candidates = new Set(previous?.registryAccounts ?? [])
		for await (const { value } of this.storage.iterate("account-registry:account:")) candidates.add(value)
		const registryAccounts: string[] = []
		const removedRegistryAccounts = new Set(previous?.removedRegistryAccounts ?? [])
		for (const address of candidates) {
			const discovery = await this.storage.get(`account-registry:discovered:${address}`)
			let keep = discovery !== undefined && Number(discovery) <= block.number
			if (discovery === undefined && block.number >= birthday) {
				keep =
					(
						await this.contract.getState(EthereumAddress.fromString(address), {
							blockHash: block.hash,
							requireCanonical: true,
						})
					).meta.leafCount > 0
			}
			if (keep) {
				registryAccounts.push(address)
				removedRegistryAccounts.delete(address)
			} else removedRegistryAccounts.add(address)
		}
		const recovery = {
			block,
			legacy,
			accounts,
			registryAccounts,
			removedRegistryAccounts: [...removedRegistryAccounts],
		}
		await this.storage.put("chain:recovery", JSON.stringify(recovery))
		return recovery
	}

	private async recover(recovery: Recovery): Promise<void> {
		this.coordinator.generation++
		for (const callback of this.resetSubscribers) {
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
			if (recovery.legacy || (match && Number(match[1]) > recovery.block.number)) await this.storage.delete(key)
		}
		const cursor = await this.storage.get("events:latestPolledBlock")
		if (cursor !== undefined)
			await this.storage.put("events:latestPolledBlock", String(Math.min(Number(cursor), recovery.block.number)))
		const birthday = await this.contract.getSingletonBirthdayBlockNum()
		const registryCursor = await this.storage.get("account-registry:lastProcessedBlock")
		if (registryCursor !== undefined)
			await this.storage.put(
				"account-registry:lastProcessedBlock",
				String(recovery.legacy ? Math.max(0, birthday - 1) : Math.min(Number(registryCursor), recovery.block.number))
			)
		for await (const { key } of this.storage.iterate("account-registry:account:")) await this.storage.delete(key)
		for (let i = 0; i < recovery.registryAccounts.length; i++)
			await this.storage.put(`account-registry:account:${i}`, recovery.registryAccounts[i])
		for (const address of recovery.removedRegistryAccounts)
			await this.storage.delete(`account-registry:discovered:${address}`)
		if ((await this.contract.getBlock(recovery.block.number)).hash !== recovery.block.hash)
			throw new ChainChangedError()
		await this.storage.put("chain:head", JSON.stringify(recovery.block))
		await this.storage.delete("chain:recovery")
		for (const callback of this.resetSubscribers) {
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
			for (const callback of this.rollbackSubscribers) {
				try {
					callback(event)
				} catch (error) {
					console.error(error)
				}
			}
		}
	}
}
