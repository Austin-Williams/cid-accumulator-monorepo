import { CID } from "../ipfs/CID.js"
import { encodeBlock } from "../utils/codec.js"
import type { PeakWithHeight } from "./types.js"
import { NULL_CID } from "../utils/constants.js"

// Computes the root CID from an array of peak CIDs, left-to-right bagging (canonical MMR logic).
// @param peaks Array of CIDs (left-to-right order)
// @returns The root CID (or the zero CID if peaks is empty)
export async function getRootCIDFromPeaks(peaks: CID<unknown, 113, 27, 1>[]): Promise<CID<unknown, 113, 27, 1>> {
	if (peaks.length === 0) {
		return NULL_CID
	}
	if (peaks.length === 1) {
		return peaks[0]
	}
	let current = peaks[0]
	for (let i = 1; i < peaks.length; i++) {
		const { cid } = await encodeBlock({ L: current, R: peaks[i] })
		current = cid
	}
	return current
}

// Reconstructs the state before the latest append from the left peaks recorded in its event.
// The payload argument is retained for compatibility; the merge hashes contain all the previous peaks needed.
export async function computePreviousRootCIDAndPeaksWithHeights(
	currentPeaksWithHeights: PeakWithHeight[],
	_payload: Uint8Array,
	mergeLeftHashesDuringLatestMerge: CID<unknown, 113, 27, 1>[]
): Promise<{ previousRootCID: CID<unknown, 113, 27, 1>; previousPeaksWithHeights: PeakWithHeight[] }> {
	if (currentPeaksWithHeights.length === 0) {
		return { previousRootCID: NULL_CID, previousPeaksWithHeights: [] }
	}

	// An append replaces the consumed rightmost peaks with one new peak, or simply adds a leaf peak.
	const previousPeaksWithHeights = currentPeaksWithHeights.slice(0, -1).map((p) => ({ cid: p.cid, height: p.height }))

	// The event records consumed peaks at heights 0, 1, ...; restore them in descending height order.
	for (let i = mergeLeftHashesDuringLatestMerge.length - 1; i >= 0; i--) {
		previousPeaksWithHeights.push({ cid: mergeLeftHashesDuringLatestMerge[i], height: i })
	}

	const previousRootCID = await getRootCIDFromPeaks(previousPeaksWithHeights.map((p) => p.cid))
	return { previousRootCID, previousPeaksWithHeights }
}
