import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import {
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
	defaultLightClientIpfsResolverConfig,
} from "../source/config/defaultConfig.js"
import { LightClient } from "../source/core/lightClient/LightClient.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import type { NormalizedLeafAppendedEvent } from "../source/ethereum/events.types.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import { MerkleMountainRange } from "../source/mmr/MerkleMountainRange.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { putLeafRecordInDB } from "../source/storage/utils.js"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture(t: TestContext) {
	t.mock.method(console, "log", () => {})
	t.mock.method(console, "warn", () => {})
	t.mock.method(console, "error", () => {})
	const account = new EthereumAddress("0x" + "ab".repeat(20))
	const storage = new InMemoryAdapter()
	const contract = new AccumulatorContract({ ...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: "0x" + "ab".repeat(20) })
	mockChain(t, contract, storage)
	const mmr = new MerkleMountainRange()
	const logs: NormalizedLeafAppendedEvent[] = []
	function snapshot() {
		const heights = [...mmr.leafCount.toString(2)].flatMap((bit, index, bits) =>
			bit === "1" ? [bits.length - index - 1] : []
		)
		return {
			meta: {
				leafCount: mmr.leafCount,
				peakCount: heights.length,
				peakHeights: heights,
				previousInsertBlockNumber: logs.length,
				deployBlockNumber: 1,
			},
			peaks: mmr.peaks.map((cid, index) => ({ cid, height: heights[index] })),
		}
	}
	const getState = t.mock.method(contract, "getState", async () => snapshot())
	t.mock.method(contract, "getSingletonBirthdayBlockNum", async () => 1)
	t.mock.method(contract, "getBlockNumber", async () => Math.max(1, logs.length))
	t.mock.method(contract, "getLeafAppendedLogs", async (from: number, to: number) =>
		logs.filter((event) => event.blockNumber >= from && event.blockNumber <= to)
	)
	const events = new EventCacheService(storage, contract, defaultLightClientEventCacheServiceConfig)
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	const resolve = t.mock.method(resolver, "fullyResolveCID", async () => undefined)
	const client = new LightClient(account, {
		storage,
		accumulatorContract: contract,
		eventCacheService: events,
		ipfsResolver: resolver,
	})
	t.after(() => {
		try {
			client.stop()
		} finally {
			events.stop()
			resolver.stop()
			contract.stop()
		}
	})
	async function append(payload: Uint8Array, cache = true) {
		const leafIndex = mmr.leafCount
		const previousPeaks = [...mmr.peaks]
		await mmr.addLeafWithTrail(leafIndex, payload)
		const mergeCount = previousPeaks.length + 1 - mmr.peaks.length
		const event: NormalizedLeafAppendedEvent = {
			account,
			leafIndex,
			payload,
			blockNumber: logs.length + 1,
			previousInsertBlockNumber: logs.length,
			mergeLeftHashes: previousPeaks.slice(previousPeaks.length - mergeCount).reverse(),
		}
		logs.push(event)
		if (cache) await events.fetchAndStoreEventsForBlock(event.blockNumber)
		return event
	}
	return {
		account,
		client,
		storage,
		events,
		getState,
		resolve,
		snapshot,
		append,
		put: (index: number, payload: Uint8Array) =>
			putLeafRecordInDB(storage, account, index, { account, leafIndex: index, payload }),
	}
}

describe("sync snapshots while the contract advances", { concurrency: false, timeout: 5000 }, () => {
	for (const initialLeafCount of [0, 1]) {
		test(`an append during a delayed ${initialLeafCount}-leaf snapshot refreshes shared sync`, async (t) => {
			const f = fixture(t)
			if (initialLeafCount) await f.append(Uint8Array.of(1))
			const captured = deferred()
			const release = deferred()
			f.getState.mock.mockImplementationOnce(async () => {
				const state = f.snapshot()
				captured.resolve()
				await release.promise
				return state
			})
			const sync = f.client.sync()
			assert.equal(f.client.sync(), sync)
			await captured.promise
			await f.append(Uint8Array.of(2))
			release.resolve()
			await sync
			assert.equal(f.client.completedInitialSync, true)
			assert.equal(f.client.syncing, false)
			assert.equal(f.getState.mock.callCount(), 2)
			assert.equal(f.resolve.mock.callCount(), 0)
			assert.equal(await f.client.getHighestIndex(), initialLeafCount)
			assert.equal(await f.client.getPayload(initialLeafCount), "02")
		})
	}

	test("an append while IPFS retrieval is pending is verified against a refreshed snapshot", async (t) => {
		const f = fixture(t)
		await f.append(Uint8Array.of(1), false)
		const entered = deferred()
		const release = deferred()
		f.resolve.mock.mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
			return {
				async *[Symbol.asyncIterator]() {
					yield { leafIndex: 0, payload: Uint8Array.of(1) }
				},
			}
		})
		const sync = f.client.sync()
		await entered.promise
		await f.append(Uint8Array.of(2))
		release.resolve()
		await sync
		assert.equal(f.client.completedInitialSync, true)
		assert.equal(f.getState.mock.callCount(), 2)
		assert.equal(f.resolve.mock.callCount(), 1)
		assert.deepEqual(await f.client.getPayloadInRange(0, 1), [
			{ index: 0, payload: "01" },
			{ index: 1, payload: "02" },
		])
	})

	test("an append during hashing is noticed after the initial cache count", async (t) => {
		const f = fixture(t)
		await f.append(Uint8Array.of(1))
		const addLeaf = MerkleMountainRange.prototype.addLeafWithTrail
		let appended = false
		t.mock.method(MerkleMountainRange.prototype, "addLeafWithTrail", async function (this: MerkleMountainRange, ...args: Parameters<typeof addLeaf>) {
			const result = await addLeaf.apply(this, args)
			if (!appended) {
				appended = true
				await f.append(Uint8Array.of(2))
			}
			return result
		})
		await f.client.sync()
		assert.equal(appended, true)
		assert.equal(f.client.completedInitialSync, true)
		assert.equal(f.getState.mock.callCount(), 2)
		assert.equal(await f.client.getPayload(1), "02")
	})

	test("a refreshed but unchanged contract still rejects extra cached leaves", async (t) => {
		const f = fixture(t)
		await f.append(Uint8Array.of(1))
		await f.put(1, Uint8Array.of(99))
		await assert.rejects(f.client.sync(), /Cache integrity check failed.*expected 1.*found 2/)
		assert.equal(f.getState.mock.callCount(), 2)
		assert.equal(f.resolve.mock.callCount(), 0)
		assert.equal(f.client.completedInitialSync, false)
		assert.equal(f.client.syncing, false)
		assert.equal(await f.client.getPayload(1), "63")
	})

	test("advancing the contract cannot make a corrupted cached prefix pass verification", async (t) => {
		const f = fixture(t)
		await f.append(Uint8Array.of(1))
		await f.put(0, Uint8Array.of(99))
		f.getState.mock.mockImplementationOnce(async () => {
			const state = f.snapshot()
			await f.append(Uint8Array.of(2))
			return state
		})
		await assert.rejects(f.client.sync(), /Cache integrity check failed.*root mismatch/)
		assert.equal(f.getState.mock.callCount(), 2)
		assert.equal(f.resolve.mock.callCount(), 0)
		assert.equal(f.client.completedInitialSync, false)
		assert.equal(f.client.syncing, false)
		assert.equal(await f.client.getPayload(0), "63")
	})

	test("continuous advancement is bounded and a later sync can retry successfully", async (t) => {
		const f = fixture(t)
		await f.append(Uint8Array.of(1))
		f.getState.mock.mockImplementation(async () => {
			const state = f.snapshot()
			await f.append(Uint8Array.of(state.meta.leafCount + 1))
			return state
		})
		await assert.rejects(f.client.sync(), (error) => {
			assert.ok(error instanceof Error)
			assert.match(error.message, /Contract kept advancing during sync.*retry sync/i)
			assert.doesNotMatch(error.message, /integrity check failed/i)
			return true
		})
		assert.equal(f.getState.mock.callCount(), 5)
		assert.equal(f.client.completedInitialSync, false)
		assert.equal(f.client.syncing, false)

		f.getState.mock.mockImplementation(async () => f.snapshot())
		await f.client.sync()
		assert.equal(f.getState.mock.callCount(), 6)
		assert.equal(f.client.completedInitialSync, true)
		assert.equal(f.client.syncing, false)
		assert.equal(await f.client.getHighestIndex(), 5)
	})

	test("light-client startup survives a valid event arriving after its initial contract snapshot", async (t) => {
		const f = fixture(t)
		await f.append(Uint8Array.of(1))
		const stoppedEvents = t.mock.method(f.events, "stop")
		const captured = deferred()
		const release = deferred()
		f.getState.mock.mockImplementationOnce(async () => {
			const state = f.snapshot()
			captured.resolve()
			await release.promise
			return state
		})
		const start = f.client.start()
		await captured.promise
		await f.append(Uint8Array.of(2))
		release.resolve()
		await start
		assert.equal(f.client.running, true)
		assert.equal(f.client.initialized, true)
		assert.equal(f.client.completedInitialSync, true)
		assert.equal(f.getState.mock.callCount(), 2)
		assert.equal(stoppedEvents.mock.callCount(), 0)
		assert.equal(await f.client.getPayload(1), "02")
	})
})
