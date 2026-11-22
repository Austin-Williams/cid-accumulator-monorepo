import type { AccumulatorContract } from "../../ethereum/AccumulatorContract.js"
import type { NormalizedDataAppendedEvent } from "../../ethereum/events.types.js"
import type { IpfsResolver } from "../../ipfs/IpfsResolver.js"
import { MerkleMountainRange } from "../../mmr/MerkleMountainRange.js"
import { computePreviousRootCIDAndPeaksWithHeights, getRootCIDFromPeaks } from "../../mmr/utils.js"
import type { AccumulatorStorageAdapter } from "../../storage/adapters/AccumulatorStorageAdapter.js"
import { deleteLeafSuffix, putLeafRecordInDB } from "../../storage/utils.js"
import type { EthereumAddress } from "../../ethereum/EthereumAddress.js"
import type { LeafRecord } from "../../mmr/types.js"
import { hexStringToUint8Array, uint8ArrayToHexString } from "../../utils/codec.js"
import { NULL_CID } from "../../utils/constants.js"
import type { RootSnapshot } from "../dataClient/DataClient.types.js"

type State = Awaited<ReturnType<AccumulatorContract["getCIDAccumulatorState"]>>

/** Logs belong to one attempt to resolve a particular contract state. Several appends can share a block. */
export function insertionLogs(contract: AccumulatorContract, blockHash?: (number: number) => Promise<string | undefined>) {
	const blocks = new Map<number, Map<number, NormalizedDataAppendedEvent>>()
	return async (block: number, index: number) => {
		let events = blocks.get(block)
		if (!events) {
			events = new Map()
			for (const event of await contract.getDataAppendedLogs(block, block, await blockHash?.(block))) {
				if (events.has(event.leafIndex)) throw new Error(`Duplicate append for leaf ${event.leafIndex} in block ${block}`)
				events.set(event.leafIndex, event)
			}
			blocks.set(block, events)
		}
		const event = events.get(index)
		if (!event) throw new Error(`Missing append for leaf ${index} in block ${block}`)
		return event
	}
}

/** Resolve the contract's root without opening any chain-scoped mutable state.
 * Verify both the CAR prefix and the suffix reconstructed from insertion logs before publishing it. */
export async function resolveRootSnapshot(
	state: State, resolver: IpfsResolver, storage: AccumulatorStorageAdapter,
	getAppend: ReturnType<typeof insertionLogs>, signal: AbortSignal, previous?: RootSnapshot
): Promise<RootSnapshot> {
	signal.throwIfAborted()
	let { peaks } = state
	let count = state.meta.leafCount
	const expected = await getRootCIDFromPeaks(peaks.map(peak => peak.cid))
	if (previous?.root.equals(expected) && previous.payloads.length === count) return previous
	if (count === 0) {
		if (!expected.equals(NULL_CID)) throw new Error("Empty accumulator has a nonempty root")
		return { root: expected, payloads: [] }
	}

	for await (const entries of storage.payloadCaches(count)) {
		const cached: string[] = []
		const cachedMmr = new MerkleMountainRange()
		for await (const payload of entries) {
			signal.throwIfAborted()
			await cachedMmr.addLeaf(cached.length, hexStringToUint8Array(payload))
			cached.push(payload)
		}
		if (cached.length === count && (await cachedMmr.rootCID()).equals(expected)) return { root: expected, payloads: cached }
	}

	let root = expected
	let block = state.meta.previousInsertBlockNumber
	const suffix: Uint8Array[] = []
	const mmr = new MerkleMountainRange()
	let payloads: string[] = []
	while (count > 0) {
		signal.throwIfAborted()
		if (previous?.root.equals(root) && previous.payloads.length === count) {
			payloads = previous.payloads.slice()
			mmr.leafCount = count
			mmr.peaks = peaks.map(peak => peak.cid)
			break
		}
		let prefix = await resolver.resolveFromCacheOrCar(root)
		if (!prefix) {
			signal.throwIfAborted()
			try {
				const append = await getAppend(block, count - 1)
				const before = await computePreviousRootCIDAndPeaksWithHeights(peaks, append.payload, append.mergeLeftHashes)
				suffix.push(append.payload)
				block = append.previousInsertBlockNumber
				root = before.previousRootCID
				peaks = before.previousPeaksWithHeights
				count--
				continue
			} catch (error) {
				signal.throwIfAborted()
				// A gateway that serves only individual blocks can still recover a tree if the RPC lacks its logs.
				prefix = await resolver.resolveFromIndividualBlocks(root)
				if (!prefix) throw error
			}
		}
		for await (const { leafIndex, payload } of prefix) {
			signal.throwIfAborted()
			if (leafIndex !== payloads.length || leafIndex >= count) throw new Error("Unexpected leaf index in IPFS tree")
			await mmr.addLeaf(leafIndex, payload)
			payloads.push(uint8ArrayToHexString(payload))
		}
		if (payloads.length !== count || !(await mmr.rootCID()).equals(root)) throw new Error("IPFS payloads do not match the expected MMR")
		break
	}
	for (const payload of suffix.reverse()) {
		signal.throwIfAborted()
		const trail = await mmr.addLeafWithTrail(payloads.length, payload)
		for (const node of trail) await resolver.cacheBlock(node)
		payloads.push(uint8ArrayToHexString(payload))
	}
	if (payloads.length !== state.meta.leafCount || !(await mmr.rootCID()).equals(expected)) {
		throw new Error("Append payloads do not match the contract's MMR root")
	}
	return { root: expected, payloads }
}

/** Install a verified snapshot in the live account index under its chain coordinator's lock. */
export async function storeRootSnapshot(
	storage: AccumulatorStorageAdapter, account: EthereumAddress, snapshot: RootSnapshot, appends: LeafRecord[]
): Promise<void> {
	const { payloads } = snapshot
	let highest = -1
	let replaceFrom = payloads.length
	const matchingFields = new Uint8Array(payloads.length)
	const prefix = `account:${account}:leaf:`
	for await (const { key, value } of storage.iterate(prefix)) {
		const match = /^(\d+):([^:]+)$/.exec(key.slice(prefix.length))
		if (!match) continue
		const i = Number(match[1])
		const field = match[2]
		highest = Math.max(highest, i)
		if (i >= payloads.length) continue
		if (field === "payload" && value !== payloads[i]) replaceFrom = Math.min(replaceFrom, i)
		if ((field === "account" && value === account.toString()) || (field === "leafIndex" && value === String(i)) ||
			(field === "payload" && value === payloads[i])) matchingFields[i]++
	}
	if (replaceFrom <= highest) await deleteLeafSuffix(storage, account, replaceFrom, highest + 1)
	const firstAppend = payloads.length - appends.length
	for (let i = 0; i < payloads.length; i++) {
		if (i >= firstAppend) {
			await putLeafRecordInDB(storage, account, i, appends[i - firstAppend])
		} else if (i >= replaceFrom || matchingFields[i] !== 3) {
			await putLeafRecordInDB(storage, account, i, { account, leafIndex: i, payload: hexStringToUint8Array(payloads[i]) })
		}
	}
	await storage.rememberPayloadCache()
}
