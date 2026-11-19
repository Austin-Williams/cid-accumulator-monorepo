import type { MMRLeafAppendedTrail } from "./types.js"
import { CID } from "../ipfs/CID.js"
import { encodeBlock } from "../utils/codec.js"
import { getRootCIDFromPeaks } from "./utils.js"
import { createLogger } from "../utils/logging.js"
import type { Logger } from "../types/common.js"

export class MerkleMountainRange {
	public peaks: CID<unknown, 113, 27, 1>[] = []
	public leafCount = 0
	private leafAppendedTrailSubscribers: ((trail: MMRLeafAppendedTrail) => void)[] = []
	protected logger: Logger

	constructor() {
		this.logger = createLogger("MerkleMountainRange")
	}

	// Subscribe to be notified whenever addLeafWithTrail is called.
	// @param callback Callback receiving the MMRLeafAppendedTrail for each new leaf
	// @returns Unsubscribe function
	public subscribeToLeafAppendedTrail(callback: (trail: MMRLeafAppendedTrail) => void): () => void {
		this.leafAppendedTrailSubscribers.push(callback)
		return () => {
			const idx = this.leafAppendedTrailSubscribers.indexOf(callback)
			if (idx !== -1) this.leafAppendedTrailSubscribers.splice(idx, 1)
		}
	}

	/** Updates the peaks. A caller publishing blocks can collect the new leaf and merges in a trail. */
	async addLeaf(leafIndex: number, payload: Uint8Array, trail?: MMRLeafAppendedTrail): Promise<void> {
		if (this.leafCount !== leafIndex) throw new Error(`Expected leafIndex ${this.leafCount} but got ${leafIndex}`)

		const leaf = await encodeBlock(payload)
		trail?.push(leaf)

		let newPeak = leaf.cid
		let height = 0

		while ((this.leafCount >> height) & 1) {
			const left = this.peaks.pop()
			if (!left) throw new Error("MMR structure error: no peak to merge")

			const merged = await encodeBlock({ L: left, R: newPeak })
			trail?.push(merged)

			newPeak = merged.cid
			height++
		}

		this.peaks.push(newPeak)
		this.leafCount++
	}

	/** Returns the new leaf, its merge blocks, and any blocks needed to link the peaks into a root. */
	async addLeafWithTrail(leafIndex: number, payload: Uint8Array): Promise<MMRLeafAppendedTrail> {
		const trail: MMRLeafAppendedTrail = []
		await this.addLeaf(leafIndex, payload, trail)
		await getRootCIDFromPeaks(this.peaks, trail)

		// Notify all subscribers
		for (const cb of this.leafAppendedTrailSubscribers) {
			try {
				cb(trail)
			} catch (err) {
				this.logger.error(`Error in leafAppendedTrail subscriber: ${err}`)
			}
		}

		return trail
	}

	// Returns the root CID and the trail of CID/Data pairs needed to compute the root.
	// @returns An object containing the root CID and the trail of CID/Data pairs.
	// The root is redundant (because the last item in the trail is the root) but convenient.
	async rootCIDWithTrail(): Promise<{
		root: CID<unknown, 113, 27, 1> // Redundant (because the last item in the trail is the root) but convenient
		trail: MMRLeafAppendedTrail
	}> {
		const trail: MMRLeafAppendedTrail = []

		const root = await getRootCIDFromPeaks(this.peaks, trail)
		return { root, trail }
	}

	async rootCID(): Promise<CID<unknown, 113, 27, 1>> {
		return getRootCIDFromPeaks(this.peaks)
	}

	async rootCIDAsBase32(): Promise<string> {
		const cid = await this.rootCID()
		return cid.toString()
	}
}
