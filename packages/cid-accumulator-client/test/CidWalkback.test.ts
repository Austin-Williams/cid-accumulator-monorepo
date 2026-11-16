import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import {
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
} from "../source/config/defaultConfig.js"
import { DataClient } from "../source/core/dataClient/DataClient.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import type { NormalizedLeafAppendedEvent } from "../source/ethereum/events.types.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import type { CIDDataPair } from "../source/ipfs/types.js"
import { MerkleMountainRange } from "../source/mmr/MerkleMountainRange.js"
import type { PeakWithHeight } from "../source/mmr/types.js"
import { computePreviousRootCIDAndPeaksWithHeights } from "../source/mmr/utils.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { isInternalNode, uint8ArrayToHexString } from "../source/utils/codec.js"
import { NULL_CID } from "../source/utils/constants.js"
import * as dagCbor from "../source/utils/dagCbor.js"

type State = { root: CIDDataPair["cid"]; peaks: PeakWithHeight[] }
type Append = { payload: Uint8Array; mergeLeftHashes: CIDDataPair["cid"][]; trail: CIDDataPair[] }

async function buildHistory(payloads: Uint8Array[]) {
	const mmr = new MerkleMountainRange()
	const states: State[] = [{ root: await mmr.rootCID(), peaks: [] }]
	const appends: Append[] = []
	for (const [index, payload] of payloads.entries()) {
		const trail = await mmr.addLeafWithTrail(index, payload)
		// Each set bit of the leaf count corresponds to a peak, from highest to lowest.
		const bits = mmr.leafCount.toString(2)
		const heights = [...bits].flatMap((bit, position) => (bit === "1" ? [bits.length - position - 1] : []))
		const peaks = mmr.peaks.map((cid, position) => ({ cid, height: heights[position] }))
		const mergeCount = peaks[peaks.length - 1].height
		// Read the actual left inputs from the forward insertion's encoded merge nodes.
		const mergeLeftHashes = trail.slice(1, mergeCount + 1).map((block) => {
			const node = dagCbor.decode(block.dagCborEncodedData)
			assert.ok(isInternalNode(node))
			return node.L
		})
		appends.push({ payload, mergeLeftHashes, trail })
		states.push({ root: await mmr.rootCID(), peaks })
	}
	return { states, appends }
}

function serializePeaks(peaks: PeakWithHeight[]) {
	return peaks.map(({ cid, height }) => ({ cid: cid.toString(), height }))
}

describe("historical CID reconstruction", { concurrency: false, timeout: 5000 }, () => {
	test("an empty accumulator has an empty previous state", async () => {
		const result = await computePreviousRootCIDAndPeaksWithHeights([], new Uint8Array(), [])
		assert.equal(result.previousRootCID.toString(), NULL_CID.toString())
		assert.deepEqual(result.previousPeaksWithHeights, [])
	})

	for (const kind of ["distinct", "repeated", "empty"] as const) {
		test(`walking back 65 ${kind} payloads restores every forward state without mutating inputs`, async () => {
			const payloads = Array.from({ length: 65 }, (_, index) =>
				kind === "empty" ? new Uint8Array() : Uint8Array.of(kind === "repeated" ? 7 : index + 1)
			)
			const { states, appends } = await buildHistory(payloads)
			let currentPeaks = states[payloads.length].peaks
			for (let count = payloads.length; count > 0; count--) {
				const { payload, mergeLeftHashes } = appends[count - 1]
				Object.freeze(currentPeaks)
				currentPeaks.forEach(Object.freeze)
				Object.freeze(mergeLeftHashes)
				const result = await computePreviousRootCIDAndPeaksWithHeights(currentPeaks, payload, mergeLeftHashes)
				assert.equal(result.previousRootCID.toString(), states[count - 1].root.toString(), `Root before leaf ${count}`)
				assert.deepEqual(
					serializePeaks(result.previousPeaksWithHeights),
					serializePeaks(states[count - 1].peaks),
					`Peaks before leaf ${count}`
				)
				currentPeaks = result.previousPeaksWithHeights
			}
		})
	}

	for (const [leafCount, pinnedCount] of [
		[2, 1],
		[8, 7],
		[13, 5],
	] as const) {
		test(`syncing ${leafCount} leaves finds the available ${pinnedCount}-leaf historical IPFS root`, async (t) => {
			t.mock.method(console, "log", () => {})
			t.mock.method(console, "warn", () => {})
			t.mock.method(console, "error", () => {})
			const payloads = Array.from({ length: leafCount }, (_, index) => Uint8Array.of(index + 1))
			const { states, appends } = await buildHistory(payloads)
			const availableBlocks = new Map<string, Uint8Array>()
			for (const { trail } of appends.slice(0, pinnedCount)) {
				for (const block of trail) availableBlocks.set(block.cid.toString(), block.dagCborEncodedData)
			}
			t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
				const url = new URL(input instanceof Request ? input.url : input.toString())
				const bytes = url.search ? undefined : availableBlocks.get(url.pathname.slice("/ipfs/".length))
				return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 })
			})
			const storage = new InMemoryAdapter()
			const resolver = new IpfsResolver(storage, {
				gatewayUrl: "https://ipfs.example.test",
				rateLimiterOptions: { intervalMs: 0, maxRetries: 0, baseDelay: 0, capDelay: 0 },
			})
			const resolve = t.mock.method(resolver, "fullyResolveCID")
			const account = new EthereumAddress("0x" + "11".repeat(20))
			const contract = new AccumulatorContract(defaultLightClientAccumulatorContractConfig)
			mockChain(t, contract, storage)
			t.mock.method(contract, "getSingletonBirthdayBlockNum", async () => 1)
			t.mock.method(contract, "getState", async () => ({
				meta: {
					leafCount,
					peakCount: states[leafCount].peaks.length,
					peakHeights: states[leafCount].peaks.map((peak) => peak.height),
					previousInsertBlockNumber: leafCount,
					deployBlockNumber: 1,
				},
				peaks: states[leafCount].peaks,
			}))
			const events: NormalizedLeafAppendedEvent[] = appends.map(({ payload, mergeLeftHashes }, index) => ({
				account,
				leafIndex: index,
				payload,
				blockNumber: index + 1,
				previousInsertBlockNumber: index,
				mergeLeftHashes,
			}))
			const getLogs = t.mock.method(contract, "getLeafAppendedLogs", async (from: number, to: number) => {
				assert.ok(from > pinnedCount, "Leaves under the historical root should come from IPFS")
				return events.filter((event) => event.blockNumber >= from && event.blockNumber <= to)
			})
			const eventCacheService = new EventCacheService(storage, contract, defaultLightClientEventCacheServiceConfig)
			const client = new DataClient(account, {
				storage,
				accumulatorContract: contract,
				eventCacheService,
				ipfsResolver: resolver,
			})
			t.after(() => {
				eventCacheService.stop()
				resolver.stop()
				contract.stop()
			})

			await client.sync()
			assert.equal(client.completedInitialSync, true)
			assert.equal(client.syncing, false)
			assert.deepEqual(
				await client.getPayloadInRange(0, leafCount - 1),
				payloads.map((payload, index) => ({ index, payload: uint8ArrayToHexString(payload) }))
			)
			assert.deepEqual(
				resolve.mock.calls.map((call) => call.arguments[0].toString()),
				states
					.slice(pinnedCount)
					.reverse()
					.map((state) => state.root.toString())
			)
			assert.deepEqual(
				getLogs.mock.calls.map((call) => call.arguments.slice(0, 2)),
				Array.from({ length: leafCount - pinnedCount }, (_, index) => [leafCount - index, leafCount - index])
			)
		})
	}
})
