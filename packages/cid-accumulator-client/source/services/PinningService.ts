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

/** Pins the configured accumulator's payloads and all intermediate DAG nodes. */
export class PinningService implements LifecycleComponent {
	public mmr = new MerkleMountainRange()
	private syncingMmr?: MerkleMountainRange
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
		private syncCheckIntervalMs: number
	) {}

	public async init(): Promise<void> {
		this.chain ??= await getChainState(this.storage, this.accumulatorContract)
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
			const previous = this.mmr
			const restored = new MerkleMountainRange()
			// Do not skip canonical leaves that have not been pinned yet.
			if (previous.leafCount <= event.firstInvalidLeafIndex) {
				restored.leafCount = previous.leafCount
				restored.peaks = [...previous.peaks]
			} else {
				restored.leafCount = event.firstInvalidLeafIndex
				restored.peaks = event.peaks.map((peak) => peak.cid)
			}
			this.mmr = restored
			this.syncingMmr = undefined
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
			for (let i = mmr.leafCount; i <= highestInDb; i++) {
				if (!this.isRunning || this.mmr !== mmr) return
				await this.processLeafIndex(mmr, i, snapshot)
			}
		} finally {
			// An old upload must not unlock a new run or replacement MMR.
			if (this.syncingMmr === mmr) this.syncingMmr = undefined
		}
	}

	private async processLeafIndex(mmr: MerkleMountainRange, leafIndex: number, snapshot: ChainSnapshot): Promise<void> {
		const account = this.accumulatorContract.address
		const payloadData = await this.chain!.read(async () => {
			const payload = await this.storage.get(getAccountLeafPayloadKey(account, leafIndex))
			if (payload === undefined) throw new Error(`No payload data found for leaf index ${leafIndex}`)
			return hexStringToUint8Array(payload)
		})
		const candidate = new MerkleMountainRange()
		candidate.peaks = [...mmr.peaks]
		candidate.leafCount = mmr.leafCount
		const trail = await this.appendToMMRAndStoreMetadata(candidate, leafIndex, payloadData, snapshot)

		for (const pair of trail) await this.ipfsPinner.putAndPin(pair, account)
		if (!this.isRunning || this.mmr !== mmr) return
		await this.chain!.ensureCanonical(snapshot)
		await this.chain!.commit(snapshot, async () => {
			if (!this.isRunning || this.mmr !== mmr) return
			await mmr.addLeafWithTrail(leafIndex, payloadData)
		})
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
			if (!(await this.verifyRootCIDs())) await this.sync()
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
		const state = await this.accumulatorContract.getState({ blockHash: snapshot.block.hash, requireCanonical: true })
		const onChainRootCID = await getRootCIDFromPeaks(state.peaks.map((peak) => peak.cid))
		const localRootCID = await mmr.rootCID()
		await this.chain!.ensureCanonical(snapshot)
		return this.mmr === mmr && onChainRootCID.toString() === localRootCID.toString()
	}
}
