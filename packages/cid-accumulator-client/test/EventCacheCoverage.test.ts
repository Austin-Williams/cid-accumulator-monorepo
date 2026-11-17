import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import {
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
} from "../source/config/defaultConfig.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import type { NormalizedDataAppendedEvent } from "../source/ethereum/events.types.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"

function fixture(t: TestContext) {
	t.mock.method(console, "log", () => {})
	const intervals = t.mock.method(globalThis, "setInterval")
	const storage = new InMemoryAdapter()
	const contract = new AccumulatorContract({
		...defaultLightClientAccumulatorContractConfig,
		accumulatorContractAddress: "0x" + "ab".repeat(20),
	})
	const account = contract.address
	const logs: NormalizedDataAppendedEvent[] = [10, 12].map((blockNumber, leafIndex) => ({
		account,
		leafIndex,
		payload: new Uint8Array(32).fill(leafIndex + 1),
		blockNumber,
		previousInsertBlockNumber: leafIndex === 0 ? 0 : 10,
		mergeLeftHashes: [],
	}))
	let head = 9
	mockChain(t, contract, storage)
	t.mock.method(contract, "getBlockNumber", async () => head)
	t.mock.method(contract, "getCIDAccumulatorState", async () => ({
		meta: {
			leafCount: logs.filter(event => event.blockNumber <= head).length,
			peakCount: 0,
			peakHeights: [],
			previousInsertBlockNumber: head >= 12 ? 12 : head >= 10 ? 10 : 0,
			deployBlockNumber: head >= 10 ? 10 : 0,
		},
		peaks: [],
	}))
	const getLogs = t.mock.method(contract, "getDataAppendedLogs", async (from: number, to: number) =>
		logs.filter(event => event.blockNumber >= from && event.blockNumber <= to)
	)
	const services: EventCacheService[] = []
	function create() {
		const service = new EventCacheService(storage, contract, {
			...defaultLightClientEventCacheServiceConfig,
			pollingIntervalMs: 60000,
		})
		services.push(service)
		return service
	}
	t.after(() => {
		for (const service of services) service.stop()
		contract.stop()
	})
	async function tick() {
		const callback = intervals.mock.calls[intervals.mock.calls.length - 1]?.arguments[0]
		assert.ok(typeof callback === "function")
		await callback()
	}
	return { storage, account, getLogs, create, tick, setHead: (value: number) => { head = value } }
}

describe("event cache coverage", { concurrency: false, timeout: 5000 }, () => {
	test("polling, explicit reads, and historical prefetch share coverage including empty blocks", async (t) => {
		const f = fixture(t)
		const service = f.create()
		await service.start()
		f.setHead(12)
		await f.tick()
		service.stop()
		const calls = f.getLogs.mock.callCount()
		assert.deepEqual((await service.getLeafRecords(10, 12)).map(record => record.leafIndex), [0, 1])
		assert.deepEqual(await service.getLeafRecords(11, 11), [])
		const peer = f.create()
		await peer.syncEventsUpToLatestBlock()
		assert.deepEqual((await peer.getLeafRecords(10, 12)).map(record => record.leafIndex), [0, 1])
		assert.equal(f.getLogs.mock.callCount(), calls)
		assert.equal(await f.storage.get(`events:account:${f.account}:block:9`), undefined,
			"Historical prefetch starts at the first-append birthday")
	})

	test("clearing block coverage refetches events while preserving shared payload data", async (t) => {
		const f = fixture(t)
		f.setHead(12)
		const service = f.create()
		await service.getLeafRecords(10, 12)
		const calls = f.getLogs.mock.callCount()
		await service.clearEventCache({ beforeBlock: 12 })
		assert.equal((await service.getLeafRecords(12, 12)).length, 1)
		assert.equal(f.getLogs.mock.callCount(), calls)
		assert.equal(await f.storage.get(`account:${f.account}:leaf:0:payload`), "01".repeat(32))
		assert.equal((await service.getLeafRecords(10, 10)).length, 1)
		assert.equal(f.getLogs.mock.callCount(), calls + 1)
		await service.getLeafRecords(10, 10)
		assert.equal(f.getLogs.mock.callCount(), calls + 1)
	})
})
