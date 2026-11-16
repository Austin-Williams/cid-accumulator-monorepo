import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import {
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
	defaultLightClientIpfsResolverConfig,
} from "../source/config/defaultConfig.js"
import { DataClient } from "../source/core/dataClient/DataClient.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import type { NormalizedLeafAppendedEvent } from "../source/ethereum/events.types.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import { MerkleMountainRange } from "../source/mmr/MerkleMountainRange.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { putLeafRecordInDB } from "../source/storage/utils.js"
import { encodeBlock, uint8ArrayToHexString } from "../source/utils/codec.js"

async function fixture(t: TestContext, payloads: Uint8Array[]) {
	t.mock.method(console, "log", () => {})
	t.mock.method(console, "warn", () => {})
	t.mock.method(console, "error", () => {})
	const account = new EthereumAddress("0x" + "11".repeat(20))
	const mmr = new MerkleMountainRange()
	const events: NormalizedLeafAppendedEvent[] = []
	for (const [index, payload] of payloads.entries()) {
		const previousPeaks = [...mmr.peaks]
		await mmr.addLeafWithTrail(index, payload)
		const mergeCount = previousPeaks.length + 1 - mmr.peaks.length
		events.push({
			account,
			leafIndex: index,
			payload,
			blockNumber: index + 1,
			previousInsertBlockNumber: index,
			mergeLeftHashes: previousPeaks.slice(previousPeaks.length - mergeCount).reverse(),
		})
	}
	const bits = payloads.length.toString(2)
	const heights = [...bits].flatMap((bit, index) => (bit === "1" ? [bits.length - index - 1] : []))
	const state = {
		meta: {
			leafCount: payloads.length,
			peakCount: heights.length,
			peakHeights: heights,
			previousInsertBlockNumber: payloads.length,
			deployBlockNumber: 1,
		},
		peaks: mmr.peaks.map((cid, index) => ({ cid, height: heights[index] })),
	}
	const root = await mmr.rootCID()
	const storage = new InMemoryAdapter()
	const contract = new AccumulatorContract(defaultLightClientAccumulatorContractConfig)
	mockChain(t, contract, storage)
	const getState = t.mock.method(contract, "getState", async () => state)
	t.mock.method(contract, "getSingletonBirthdayBlockNum", async () => 1)
	const getLogs = t.mock.method(contract, "getLeafAppendedLogs", async (from: number, to: number) =>
		events.filter((event) => event.blockNumber >= from && event.blockNumber <= to)
	)
	const eventCacheService = new EventCacheService(storage, contract, defaultLightClientEventCacheServiceConfig)
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	const resolve = t.mock.method(resolver, "fullyResolveCID", async () => undefined)
	const client = new DataClient(account, {
		storage,
		accumulatorContract: contract,
		eventCacheService,
		ipfsResolver: resolver,
	})
	t.after(() => {
		resolver.stop()
		eventCacheService.stop()
		contract.stop()
	})
	return {
		account,
		client,
		storage,
		getState,
		getLogs,
		resolve,
		events,
		payloads,
		root,
		state,
		put: (index: number, payload: Uint8Array) =>
			putLeafRecordInDB(storage, account, index, { account, leafIndex: index, payload }),
		serveIpfs: (downloaded: Uint8Array[]) => {
			resolve.mock.mockImplementation(async () => ({
				async *[Symbol.asyncIterator]() {
					for (const [leafIndex, payload] of downloaded.entries()) yield { leafIndex, payload }
				},
			}))
		},
	}
}

async function rejectsIntegrity(client: DataClient, reason: RegExp) {
	await assert.rejects(client.sync(), (error) => {
		assert.ok(error instanceof Error)
		assert.match(error.message, /cache integrity check failed/i)
		assert.match(error.message, reason)
		return true
	})
	assert.equal(client.completedInitialSync, false)
	assert.equal(client.syncing, false)
}

describe("cached payload integrity", { concurrency: false, timeout: 5000 }, () => {
	for (const payloads of [[], [Uint8Array.of(1)], [Uint8Array.of(7), new Uint8Array(), Uint8Array.of(7)]]) {
		test(`a valid ${payloads.length}-leaf cache verifies in leaf order using one contract snapshot`, async (t) => {
			const f = await fixture(t, payloads)
			// Storage iteration order is intentionally different from leaf order.
			for (let index = payloads.length - 1; index >= 0; index--) await f.put(index, payloads[index])
			const other = new EthereumAddress("0x" + "22".repeat(20))
			await putLeafRecordInDB(f.storage, other, 0, { account: other, leafIndex: 0, payload: Uint8Array.of(99) })
			await f.client.sync()
			assert.equal(f.client.completedInitialSync, true)
			assert.equal(f.getState.mock.callCount(), 1)
			assert.equal(f.resolve.mock.callCount(), 0)
			assert.equal(f.getLogs.mock.callCount(), 0)
			for (const [index, payload] of payloads.entries())
				assert.equal(await f.client.getPayload(index), uint8ArrayToHexString(payload))
		})
	}

	for (const corruption of ["changed", "reordered"] as const) {
		test(`${corruption} payloads fail even when the count and cached root metadata match`, async (t) => {
			const f = await fixture(t, [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)])
			const cached =
				corruption === "changed" ? [f.payloads[0], Uint8Array.of(99), f.payloads[2]] : [...f.payloads].reverse()
			for (const [index, payload] of cached.entries()) await f.put(index, payload)
			await f.storage.put(`account:${f.account}:leafIndex:2:rootCidAfterInsert`, f.root.toString())
			await rejectsIntegrity(f.client, /root/i)
			assert.equal(f.resolve.mock.callCount(), 0)
			assert.equal(f.getLogs.mock.callCount(), 0)
			assert.equal(await f.client.getPayload(1), uint8ArrayToHexString(cached[1]))
		})
	}

	test("a previously verified cache fails when the contract changes to a different root with the same leaf count", async (t) => {
		const f = await fixture(t, [Uint8Array.of(1)])
		await f.put(0, f.payloads[0])
		await f.client.sync()
		const replacement = await encodeBlock(Uint8Array.of(99))
		f.getState.mock.mockImplementation(async () => ({ ...f.state, peaks: [{ cid: replacement.cid, height: 0 }] }))
		await rejectsIntegrity(f.client, /root/i)
		assert.equal(await f.client.getPayload(0), "01")
	})

	for (const [leafCount, extraIndex] of [
		[0, 0],
		[1, 1],
		[1, 10],
	] as const) {
		test(`a ${leafCount}-leaf contract rejects an extra cached payload at index ${extraIndex}`, async (t) => {
			const f = await fixture(
				t,
				Array.from({ length: leafCount }, () => Uint8Array.of(1))
			)
			for (const [index, payload] of f.payloads.entries()) await f.put(index, payload)
			await f.put(extraIndex, Uint8Array.of(99))
			f.serveIpfs(f.payloads)
			await rejectsIntegrity(f.client, /payloads/i)
			assert.equal(await f.client.getPayload(extraIndex), "63")
		})
	}

	test("a payload key without its leaf record cannot pass the cached-count shortcut", async (t) => {
		const f = await fixture(t, [Uint8Array.of(1)])
		await f.storage.put(`account:${f.account}:leaf:0:payload`, "01")
		await rejectsIntegrity(f.client, /missing.*0/i)
	})

	for (const corruption of ["changed", "extra"] as const) {
		test(`${corruption} payloads returned by IPFS fail final verification`, async (t) => {
			const f = await fixture(t, [Uint8Array.of(1)])
			f.serveIpfs(corruption === "changed" ? [Uint8Array.of(99)] : [f.payloads[0], Uint8Array.of(99)])
			await rejectsIntegrity(f.client, corruption === "changed" ? /root/i : /payloads/i)
			assert.equal(f.resolve.mock.callCount(), 1)
			assert.equal(f.getLogs.mock.callCount(), 0)
		})
	}

	for (const leafCount of [1, 3]) {
		test(`incorrect event data fails verification after syncing ${leafCount} leaves`, async (t) => {
			const f = await fixture(
				t,
				Array.from({ length: leafCount }, (_, index) => Uint8Array.of(index + 1))
			)
			f.events[leafCount - 1].payload = Uint8Array.of(99)
			await rejectsIntegrity(f.client, /root/i)
			assert.ok(f.getLogs.mock.callCount() > 0)
		})
	}

	test("a stale cached prefix cannot pass after newer leaves are filled from events", async (t) => {
		const f = await fixture(
			t,
			Array.from({ length: 4 }, (_, index) => Uint8Array.of(index + 1))
		)
		await f.put(0, Uint8Array.of(99))
		await f.put(1, f.payloads[1])
		await rejectsIntegrity(f.client, /root/i)
		assert.equal(f.getLogs.mock.callCount(), 3)
		assert.equal(await f.client.getPayload(0), "63")
		assert.equal(await f.client.getPayload(3), "04")
	})

	test("concurrent callers share an integrity failure, clear the sync flag, and can retry after repair", async (t) => {
		const f = await fixture(t, [Uint8Array.of(1)])
		await f.put(0, f.payloads[0])
		await f.client.sync()
		await f.put(0, Uint8Array.of(99))
		const results = await Promise.allSettled([f.client.sync(), f.client.sync()])
		for (const result of results) {
			assert.equal(result.status, "rejected")
			if (result.status === "rejected") assert.match(result.reason.message, /cache integrity check failed.*root/i)
		}
		if (results[0].status === "rejected" && results[1].status === "rejected")
			assert.equal(results[0].reason, results[1].reason)
		assert.equal(f.client.completedInitialSync, false)
		assert.equal(f.client.syncing, false)
		assert.equal(f.getState.mock.callCount(), 2)

		await f.put(0, f.payloads[0])
		await f.client.sync()
		assert.equal(f.client.completedInitialSync, true)
		assert.equal(f.getState.mock.callCount(), 3)
	})
})
