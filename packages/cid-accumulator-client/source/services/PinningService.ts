import { defaultSeederConfig } from "../config/defaultConfig.js"
import { MerkleMountainRange } from "../mmr/MerkleMountainRange.js"
import { getRootCIDFromPeaks } from "../mmr/utils.js"
import { createLogger } from "../utils/logging.js"
import { hexStringToUint8Array, uint8ArrayToHexString, cidDataPairArrayToStringForDB } from "../utils/codec.js"
import * as dagCbor from "../utils/dagCbor.js"

import type { DataClient } from "../core/dataClient/DataClient.js"
import type { IpfsPinner } from "../ipfs/IpfsPinner.js"
import type { Storage } from "../storage/interface.js"
import type { MMRLeafAppendedTrail } from "../mmr/types.js"
import { getChainState } from "./ChainState.js"
import type { ChainSnapshot, ChainState } from "./ChainState.js"
import type { LifecycleComponent } from "../types/common.js"
import {
	getAccountLeafPayloadKey,
	getAccountLeafPayloadCIDKey,
	getAccountLeafRootCIDAfterInsertKey,
	getAccountLeafInsertionTrailKey,
} from "../utils/dbKeys.js"
import type { AccumulatorContract } from "../ethereum/AccumulatorContract.js"

type RootWindow = {
	roots: string[]
	// Pins found at startup or after rollback that have yet to match a canonical root.
	previousPins: Set<string>
}

/** Keeps a sliding window of recursively pinned accumulator roots. */
export class PinningService implements LifecycleComponent {
	public mmr = new MerkleMountainRange()
	private syncingMmr?: MerkleMountainRange
	private window?: RootWindow
	private pinName!: string
	private changingPins: Promise<void> = Promise.resolve()
	private initialized = false
	private isRunning = false
	private generation = 0
	private logger = createLogger("PinningService")
	private unsubscribeFunctions: (() => void)[] = []
	private syncCheckInterval: ReturnType<typeof setInterval> | null = null
	private chain?: ChainState

	constructor(
		private storage: Storage,
		private accumulatorContract: AccumulatorContract,
		private dataClient: DataClient,
		private ipfsPinner: IpfsPinner,
		private syncCheckIntervalMs: number,
		private retainedRoots: number = defaultSeederConfig.retainedRoots
	) {
		if (!Number.isSafeInteger(retainedRoots) || retainedRoots < 1) throw new Error("retainedRoots must be a positive safe integer")
	}

	public async init(): Promise<void> {
		this.chain ??= await getChainState(this.storage, this.accumulatorContract)
		this.pinName = `cid-accumulator-${await this.accumulatorContract.getChainId()}-${this.accumulatorContract.address}`
		await this.ipfsPinner.init()
		this.initialized = true
	}

	public async start(): Promise<void> {
		if (!this.initialized) await this.init()
		if (this.isRunning) return
		this.isRunning = true
		const generation = this.generation
		this.unsubscribeFunctions.push(this.chain!.subscribeRollback((event) => {
			if (event.account.toString() !== this.accumulatorContract.address.toString()) return
			this.mmr = new MerkleMountainRange()
			this.window = undefined
			this.sync().catch((error) => this.logger.error(`Error reconciling pins after rollback: ${error}`))
		}))
		// Subscribe before initial pinning can yield; transient upload failures keep this subscription.
		this.unsubscribeFunctions.push(this.dataClient.subscribe((event) => {
			if (event.type !== "append") return
			this.sync().catch((error) => this.logger.error(`Error pinning new leaf: ${error}`))
		}))
		await this.sanityCheck()
		if (!this.isRunning || generation !== this.generation) return
		this.syncCheckInterval = setInterval(this.sanityCheck.bind(this), this.syncCheckIntervalMs)
	}

	public stop(): void {
		this.generation++
		this.isRunning = false
		this.initialized = false
		if (this.syncCheckInterval) clearInterval(this.syncCheckInterval)
		this.syncCheckInterval = null
		this.unsubscribeFunctions.splice(0).forEach((fn) => fn())
		this.ipfsPinner.stop()
		this.window = undefined
		this.mmr = new MerkleMountainRange()
		this.syncingMmr = undefined
	}

	/** Pins cached leaves in order, retrying a failed leaf without advancing past it. */
	public async sync(): Promise<void> {
		if (!this.isRunning) return
		const generation = this.generation
		if (!this.dataClient.completedInitialSync) await this.dataClient.sync()
		if (!this.isRunning || generation !== this.generation) return
		if (!this.dataClient.completedInitialSync) throw new Error("Data client has not completed initial sync")
		const snapshot = await this.chain!.snapshot()
		if (!this.isRunning || generation !== this.generation) return
		// snapshot() may have replaced this MMR during recovery.
		const mmr = this.mmr
		if (this.syncingMmr === mmr) return
		this.syncingMmr = mmr
		try {
			const highestInDb = await this.dataClient.getHighestIndex()
			if (!this.window) {
				const window = await this.restoreWindow(mmr, highestInDb, snapshot)
				if (!this.isRunning || this.mmr !== mmr) return
				this.window = window
			}
			const window = this.window
			for (let i = mmr.leafCount; i <= highestInDb; i++) {
				if (!this.isRunning || this.mmr !== mmr) return
				await this.processLeafIndex(mmr, i, snapshot, window)
			}
			if (window.previousPins.size && this.isRunning && this.mmr === mmr) {
				await this.chain!.ensureCanonical(snapshot)
				if (this.mmr !== mmr) return
				this.changingPins = this.removeStalePins(mmr, window)
				await this.changingPins
			}
		} finally {
			// An old upload must not unlock a new run or replacement MMR.
			if (this.syncingMmr === mmr) this.syncingMmr = undefined
		}
	}

	/** A locally pinned canonical root already protects all earlier leaves and merge nodes. */
	private async restoreWindow(mmr: MerkleMountainRange, highest: number, snapshot: ChainSnapshot): Promise<RootWindow> {
		// A previous run may have been stopped in the middle of a pin RPC.
		await this.changingPins.catch(() => {})
		const { local, all } = await this.ipfsPinner.listRootPins(this.pinName)
		const account = this.accumulatorContract.address
		const firstRetained = Math.max(0, highest + 1 - this.retainedRoots)
		if (local.size && firstRetained > 0) {
			let lastPinned = highest
			while (lastPinned >= 0) {
				const cid = await this.storage.get(getAccountLeafRootCIDAfterInsertKey(account, lastPinned))
				if (cid && local.has(cid)) break
				lastPinned--
			}
			const prefix = new MerkleMountainRange()
			const count = Math.min(lastPinned + 1, firstRetained)
			for (let i = 0; i < count; i++) {
				if (this.mmr !== mmr) break
				await prefix.addLeafWithTrail(i, await this.readPayload(i))
			}
			await this.chain!.ensureCanonical(snapshot)
			mmr.peaks = prefix.peaks
			mmr.leafCount = prefix.leafCount
		}
		return { roots: [], previousPins: all }
	}

	private async removeStalePins(mmr: MerkleMountainRange, window: RootWindow): Promise<void> {
		for (const cid of window.previousPins) {
			if (this.mmr !== mmr) return
			await this.ipfsPinner.unpinRoot(cid, this.pinName)
			window.previousPins.delete(cid)
		}
	}

	private async readPayload(leafIndex: number): Promise<Uint8Array> {
		const payload = await this.storage.get(getAccountLeafPayloadKey(this.accumulatorContract.address, leafIndex))
		if (payload === undefined) throw new Error(`No payload data found for leaf index ${leafIndex}`)
		return hexStringToUint8Array(payload)
	}

	private async processLeafIndex(mmr: MerkleMountainRange, leafIndex: number, snapshot: ChainSnapshot, window: RootWindow): Promise<void> {
		const payloadData = await this.chain!.read(() => this.readPayload(leafIndex))
		const candidate = new MerkleMountainRange()
		candidate.peaks = [...mmr.peaks]
		candidate.leafCount = mmr.leafCount
		const trail = await this.appendToMMRAndStoreMetadata(candidate, leafIndex, payloadData, snapshot)

		for (const pair of trail) await this.ipfsPinner.putBlock(pair)
		if (!this.isRunning || this.mmr !== mmr) return
		await this.chain!.ensureCanonical(snapshot)
		if (this.mmr !== mmr) return
		const root = trail[trail.length - 1].cid.toString()
		this.changingPins = this.rotateRoot(mmr, window, root)
		await this.changingPins
		if (this.mmr !== mmr) return
		await this.chain!.ensureCanonical(snapshot)
		await this.chain!.commit(snapshot, async () => {
			if (!this.isRunning || this.mmr !== mmr) return
			await mmr.addLeafWithTrail(leafIndex, payloadData)
		})
	}

	private async rotateRoot(mmr: MerkleMountainRange, window: RootWindow, root: string): Promise<void> {
		if (window.roots[window.roots.length - 1] === root) return
		if (window.roots.length === this.retainedRoots) {
			const oldest = window.roots[0]
			await this.ipfsPinner.unpinRoot(oldest, this.pinName)
			window.roots.shift()
			window.previousPins.delete(oldest)
		}
		if (this.mmr !== mmr) return
		try {
			await this.ipfsPinner.pinRoot(root, this.pinName)
		} catch (error) {
			// With a window of one, GC can reclaim the preceding tree between unpin and pin.
			// Replay its missing blocks from the cached leaves on the next sync.
			if (this.retainedRoots === 1 && mmr.leafCount > 0 && this.mmr === mmr) {
				this.window = undefined
				this.mmr = new MerkleMountainRange()
			}
			throw error
		}
		window.roots.push(root)
		window.previousPins.delete(root)
	}

	private async appendToMMRAndStoreMetadata(
		mmr: MerkleMountainRange,
		leafIndex: number,
		payloadData: Uint8Array,
		snapshot: ChainSnapshot
	): Promise<MMRLeafAppendedTrail> {
		const trail = await mmr.addLeafWithTrail(leafIndex, payloadData)
		const decodedPayload = uint8ArrayToHexString(dagCbor.decode(trail[0].dagCborEncodedData) as Uint8Array)
		if (decodedPayload !== uint8ArrayToHexString(payloadData)) throw new Error(`Payload mismatch for leaf index ${leafIndex}`)
		const account = this.accumulatorContract.address
		await this.chain!.ensureCanonical(snapshot)
		await this.chain!.commit(snapshot, async () => {
			await this.storage.put(getAccountLeafPayloadCIDKey(account, leafIndex), trail[0].cid.toString())
			await this.storage.put(getAccountLeafRootCIDAfterInsertKey(account, leafIndex), trail[trail.length - 1].cid.toString())
			await this.storage.put(getAccountLeafInsertionTrailKey(account, leafIndex), cidDataPairArrayToStringForDB(trail.slice(1)))
		})
		return trail
	}

	private async sanityCheck(): Promise<void> {
		try {
			if (!this.window || this.window.previousPins.size || !(await this.verifyRootCIDs())) await this.sync()
		} catch (error) {
			this.logger.error(`Error syncing pinned accumulator: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	/** Checks the pinned MMR against a canonical on-chain snapshot. */
	public async verifyRootCIDs(): Promise<boolean> {
		if (!this.isRunning) return false
		const snapshot = await this.chain!.snapshot()
		const mmr = this.mmr
		if (mmr.leafCount === 0) return false
		const state = await this.accumulatorContract.getCIDAccumulatorState({ blockHash: snapshot.block.hash, requireCanonical: true })
		const onChainRootCID = await getRootCIDFromPeaks(state.peaks.map((peak) => peak.cid))
		const localRootCID = await mmr.rootCID()
		await this.chain!.ensureCanonical(snapshot)
		return this.mmr === mmr && onChainRootCID.toString() === localRootCID.toString()
	}
}
