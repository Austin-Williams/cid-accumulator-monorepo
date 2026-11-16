import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import {
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
} from "../source/config/defaultConfig.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import type { NormalizedLeafAppendedEvent } from "../source/ethereum/events.types.js"
import type { LeafRecord } from "../source/mmr/types.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"

function fixture(t: TestContext) {
	t.mock.method(console, "log", () => {})
	t.mock.method(console, "warn", () => {})
	t.mock.method(console, "error", () => {})
	const intervals = t.mock.method(globalThis, "setInterval")
	const storage = new InMemoryAdapter()
	const account = new EthereumAddress("0x" + "ab".repeat(20))
	const contract = new AccumulatorContract(defaultLightClientAccumulatorContractConfig)
	let head = 10
	const logs: NormalizedLeafAppendedEvent[] = []
	t.mock.method(contract, "getSingletonBirthdayBlockNum", async () => 1)
	t.mock.method(contract, "getBlockNumber", async () => head)
	t.mock.method(contract, "getLeafAppendedLogs", async (from: number, to: number) =>
		logs.filter((record) => record.blockNumber >= from && record.blockNumber <= to)
	)
	const callbacks = new Map<EventCacheService, () => unknown>()
	const createService = () => {
		const service = new EventCacheService(storage, contract, {
			...defaultLightClientEventCacheServiceConfig,
			pollingIntervalMs: 60000,
		})
		const received: LeafRecord[] = []
		service.subscribe((record) => received.push(record))
		return { service, received }
	}
	const first = createService()
	const second = createService()
	t.after(() => {
		first.service.stop()
		second.service.stop()
		contract.stop()
	})
	async function start(service: EventCacheService) {
		const previousCalls = intervals.mock.callCount()
		await service.start()
		const callback = intervals.mock.calls[previousCalls]?.arguments[0]
		assert.ok(typeof callback === "function", "Startup must schedule polling")
		callbacks.set(service, callback)
	}
	async function tick(service: EventCacheService) {
		const callback = callbacks.get(service)
		assert.ok(callback, "Service must be started before polling")
		await callback()
	}
	function append() {
		logs.push({
			account,
			leafIndex: logs.length,
			payload: Uint8Array.of(logs.length + 1),
			blockNumber: ++head,
			previousInsertBlockNumber: logs[logs.length - 1]?.blockNumber ?? 0,
			mergeLeftHashes: [],
		})
	}
	return { first, second, storage, start, tick, append }
}

describe("event notifications with shared storage", { concurrency: false, timeout: 5000 }, () => {
	test("two running services each notify their own subscribers when a peer cached the block first", async (t) => {
		const f = fixture(t)
		await f.start(f.first.service)
		await f.start(f.second.service)
		f.append()
		await f.tick(f.first.service)
		assert.deepEqual(
			f.first.received.map((record) => record.leafIndex),
			[0]
		)
		assert.equal(f.second.received.length, 0)
		await f.tick(f.second.service)
		assert.deepEqual(
			f.second.received.map((record) => record.leafIndex),
			[0]
		)
		await f.tick(f.first.service)
		await f.tick(f.second.service)
		assert.equal(f.first.received.length, 1)
		assert.equal(f.second.received.length, 1)
	})

	test("a restarting service catches downtime notifications even after a peer advanced the shared cursor", async (t) => {
		const f = fixture(t)
		await f.start(f.first.service)
		await f.start(f.second.service)
		f.first.service.stop()
		f.append()
		await f.tick(f.second.service)
		assert.equal(await f.storage.get("events:latestPolledBlock"), "11")
		assert.equal(f.first.received.length, 0)

		await f.start(f.first.service)
		assert.deepEqual(
			f.first.received.map((record) => record.leafIndex),
			[0]
		)
		assert.deepEqual(
			f.second.received.map((record) => record.leafIndex),
			[0]
		)
		f.append()
		await f.tick(f.first.service)
		await f.tick(f.second.service)
		assert.deepEqual(
			f.first.received.map((record) => record.leafIndex),
			[0, 1]
		)
		assert.deepEqual(
			f.second.received.map((record) => record.leafIndex),
			[0, 1]
		)
	})
})
