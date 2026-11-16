import { CID } from "../ipfs/CID.js"
import { encodeBlock } from "../utils/codec.js"
import type { PeakWithHeight } from "./types.js"
import { NULL_CID } from "../utils/constants.js"

// Computes the root CID from an array of peak CIDs, left-to-right bagging (canonical MMR logic).
// @param peaks Array of CIDs (left-to-right order)
// @returns The root CID (or the zero CID if peaks is empty)
export async function getRootCIDFromPeaks(peaks: CID<unknown, 113, 18, 1>[]): Promise<CID<unknown, 113, 18, 1>> {
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

export async function computePreviousRootCIDAndPeaksWithHeights(
	currentPeaksWithHeights: PeakWithHeight[],
	payload: Uint8Array,
	mergeLeftHashesDuringLatestMerge: CID<unknown, 113, 18, 1>[]
): Promise<{ previousRootCID: CID<unknown, 113, 18, 1>; previousPeaksWithHeights: PeakWithHeight[] }> {
	// Defensive copy
	let peaks: PeakWithHeight[] = currentPeaksWithHeights.map((p) => ({ cid: p.cid, height: p.height }))

	if (currentPeaksWithHeights.length == 0) return { previousRootCID: NULL_CID, previousPeaksWithHeights: [] } // if there are no peaks now, there never were

	if (mergeLeftHashesDuringLatestMerge.length === 0) {
		// No merges, just remove the peak with height 0
		const previousPeaksWithHeights = currentPeaksWithHeights.filter((p) => p.height !== 0)
		const previousRootCID: CID<unknown, 113, 18, 1> = await getRootCIDFromPeaks(
			previousPeaksWithHeights.map((p) => p.cid)
		)
		return { previousRootCID, previousPeaksWithHeights }
	}

	// Unmerge for each left input (reverse order)
	let reconstructedPeaks: PeakWithHeight[] = [...peaks]
	for (let i = mergeLeftHashesDuringLatestMerge.length - 1; i >= 0; i--) {
		const mergedPeak = reconstructedPeaks.pop()
		if (!mergedPeak) throw new Error("No mergedPeak to unmerge")
		const childHeight = mergedPeak.height - 1
		// Push left and right children as new peaks
		reconstructedPeaks.push({ cid: mergeLeftHashesDuringLatestMerge[i], height: childHeight })
		reconstructedPeaks.push({ cid: mergedPeak.cid, height: childHeight })
	}

	// Remove the new leaf peak at height 0 (not present in previous state)
	const { cid: newLeafCID } = await encodeBlock(payload)
	reconstructedPeaks = reconstructedPeaks.filter((p) => !(p.height === 0 && p.cid.toString() === newLeafCID.toString()))

	const previousRootCID: CID<unknown, 113, 18, 1> = await getRootCIDFromPeaks(reconstructedPeaks.map((p) => p.cid))

	return { previousRootCID, previousPeaksWithHeights: reconstructedPeaks }
}
