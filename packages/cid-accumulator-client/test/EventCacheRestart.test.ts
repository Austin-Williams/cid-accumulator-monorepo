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

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function fixture(t: TestContext, lazyLoadEvents = true) {
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
	const recordsFor = (from: number, to: number) =>
		logs.filter((event) => event.blockNumber >= from && event.blockNumber <= to)
	const getLogs = t.mock.method(contract, "getLeafAppendedLogs", async (from: number, to: number) =>
		recordsFor(from, to)
	)
	const services: EventCacheService[] = []
	function createService() {
		const service = new EventCacheService(storage, contract, {
			...defaultLightClientEventCacheServiceConfig,
			lazyLoadEvents,
			pollingIntervalMs: 60000,
		})
		services.push(service)
		return service
	}
	const service = createService()
	const received: LeafRecord[] = []
	service.subscribe((record) => received.push(record))
	t.after(() => {
		for (const instance of services) instance.stop()
		contract.stop()
	})
	function append(blockNumber: number) {
		const event: NormalizedLeafAppendedEvent = {
			account,
			leafIndex: logs.length,
			payload: Uint8Array.of(logs.length + 1),
			blockNumber,
			previousInsertBlockNumber: logs[logs.length - 1]?.blockNumber ?? 0,
			mergeLeftHashes: [],
		}
		logs.push(event)
		return event
	}
	function tick() {
		const callback = intervals.mock.calls[intervals.mock.calls.length - 1]?.arguments[0]
		assert.ok(typeof callback === "function", "The event polling interval must be scheduled")
		return callback()
	}
	return {
		service,
		storage,
		account,
		received,
		intervals,
		getLogs,
		recordsFor,
		append,
		tick,
		createService,
		setHead: (value: number) => {
			head = value
		},
		cursor: () => storage.get("events:latestPolledBlock"),
	}
}

describe("event cache restart catch-up", { concurrency: false, timeout: 5000 }, () => {
	test("the first lazy start saves its baseline before any tick and restart catches up from it", async (t) => {
		const f = fixture(t)
		await f.service.start()
		assert.equal(await f.cursor(), "10")
		assert.equal(f.getLogs.mock.callCount(), 0)
		f.service.stop()
		f.append(11)
		f.setHead(11)
		await f.service.start()
		assert.equal(await f.cursor(), "11")
		assert.deepEqual(
			f.received.map((record) => record.leafIndex),
			[0]
		)
		assert.deepEqual(f.getLogs.mock.calls[0].arguments.slice(0, 2), [11, 11])
		assert.equal(await f.storage.get(`account:${f.account}:leaf:0:payload`), "01")
	})

	test("a new service resumes the stored cursor and processes all downtime blocks before start resolves", async (t) => {
		const f = fixture(t)
		await f.service.start()
		f.service.stop()
		f.append(11)
		f.append(14)
		f.setHead(14)
		const restarted = f.createService()
		const received: LeafRecord[] = []
		restarted.subscribe((record) => received.push(record))
		await restarted.start()
		assert.equal(await f.cursor(), "14")
		assert.deepEqual(
			received.map((record) => record.leafIndex),
			[0, 1]
		)
		assert.equal(await f.storage.get("events:block:12"), "[]")
		assert.equal(await f.storage.get("events:block:13"), "[]")
		assert.deepEqual(f.received, [])
	})

	test("downtime blocks already cached by lazy reads are not notified twice during catch-up", async (t) => {
		const f = fixture(t)
		await f.service.start()
		f.service.stop()
		f.append(11)
		await f.service.fetchAndStoreEventsForBlock(11)
		assert.deepEqual(
			f.received.map((record) => record.leafIndex),
			[0]
		)
		f.append(12)
		f.setHead(12)
		await f.service.start()
		assert.equal(await f.cursor(), "12")
		assert.deepEqual(
			f.received.map((record) => record.leafIndex),
			[0, 1]
		)
	})

	test("a catch-up RPC failure preserves completed progress and allows start to retry", async (t) => {
		const f = fixture(t)
		await f.service.start()
		f.service.stop()
		f.append(11)
		f.append(21)
		f.setHead(25)
		const error = new Error("Second event batch unavailable")
		let fail = true
		f.getLogs.mock.mockImplementation(async (from: number, to: number) => {
			if (from === 21 && fail) {
				fail = false
				throw error
			}
			return f.recordsFor(from, to)
		})
		await assert.rejects(f.service.start(), (caught) => caught === error)
		assert.equal(await f.cursor(), "20")
		assert.equal(f.intervals.mock.callCount(), 1)
		assert.deepEqual(
			f.received.map((record) => record.leafIndex),
			[0]
		)
		await f.service.start()
		assert.equal(await f.cursor(), "25")
		assert.deepEqual(
			f.received.map((record) => record.leafIndex),
			[0, 1]
		)
		assert.equal(f.intervals.mock.callCount(), 2)
	})

	for (const failure of ["block marker", "cursor"] as const) {
		test(`a failed ${failure} write cannot advance the cursor or prevent retry`, async (t) => {
			const f = fixture(t)
			await f.service.start()
			f.service.stop()
			f.append(11)
			f.append(12)
			f.setHead(12)
			const error = new Error(`Failed to persist ${failure}`)
			const put = f.storage.put.bind(f.storage)
			let fail = true
			t.mock.method(f.storage, "put", async (key: string, value: string) => {
				const matches =
					failure === "cursor" ? key === "events:latestPolledBlock" && value === "11" : key === "events:block:11"
				if (matches && fail) {
					fail = false
					throw error
				}
				await put(key, value)
			})
			await assert.rejects(f.service.start(), (caught) => caught === error)
			assert.equal(await f.cursor(), "10")
			await f.service.start()
			assert.equal(await f.cursor(), "12")
			assert.deepEqual(
				f.received.map((record) => record.leafIndex),
				[0, 1]
			)
		})
	}

	test("an old pending poll cannot notify again or regress the cursor after restart", async (t) => {
		const f = fixture(t)
		await f.service.start()
		const first = f.append(11)
		f.setHead(11)
		const entered = deferred<void>()
		const release = deferred<NormalizedLeafAppendedEvent[]>()
		t.after(() => release.resolve([]))
		f.getLogs.mock.mockImplementationOnce(async () => {
			entered.resolve()
			return release.promise
		})
		const oldPoll = f.tick()
		await entered.promise
		f.service.stop()
		f.append(12)
		f.setHead(12)
		await f.service.start()
		assert.equal(await f.cursor(), "12")
		release.resolve([first])
		await oldPoll
		assert.equal(await f.cursor(), "12")
		assert.deepEqual(
			f.received.map((record) => record.leafIndex),
			[0, 1]
		)
	})

	test("eager prefetch and restart catch-up deliver each cached event only once", async (t) => {
		const f = fixture(t, false)
		f.append(3)
		await f.service.start()
		assert.equal(await f.cursor(), "10")
		assert.deepEqual(
			f.received.map((record) => record.leafIndex),
			[0]
		)
		f.service.stop()
		f.append(11)
		f.setHead(11)
		await f.service.start()
		assert.equal(await f.cursor(), "11")
		assert.deepEqual(
			f.received.map((record) => record.leafIndex),
			[0, 1]
		)
	})
})
