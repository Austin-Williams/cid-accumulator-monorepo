import { mockChain } from "./mockChain.js"
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
import { EventCacheService } from "../source/services/EventCacheService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { putLeafRecordInDB } from "../source/storage/utils.js"

function fixture(t: TestContext) {
	t.mock.method(console, "log", () => {})
	const intervals = t.mock.method(globalThis, "setInterval")
	const storage = new InMemoryAdapter()
	const first = new EthereumAddress("0x" + "11".repeat(20))
	const second = new EthereumAddress("0x" + "22".repeat(20))
	const third = new EthereumAddress("0x" + "33".repeat(20))
	const logs: NormalizedLeafAppendedEvent[] = (
		[
			[first, 0, 1, 10, 0],
			[second, 0, 2, 10, 0],
			[second, 1, 3, 11, 10],
			[third, 0, 4, 10, 0],
		] as const
	).map(([account, leafIndex, value, blockNumber, previousInsertBlockNumber]) => ({
		account,
		leafIndex,
		payload: Uint8Array.of(value),
		blockNumber,
		previousInsertBlockNumber,
		mergeLeftHashes: [],
	}))
	let head = 9
	const contract = new AccumulatorContract({ ...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: "0x" + "ab".repeat(20) })
	mockChain(t, contract, storage)
	t.mock.method(contract, "getSingletonBirthdayBlockNum", async () => 1)
	t.mock.method(contract, "getBlockNumber", async () => head)
	const getLogs = t.mock.method(
		contract,
		"getLeafAppendedLogs",
		async (from: number, to: number, accounts?: EthereumAddress[]) =>
			logs.filter(
				(event) =>
					event.blockNumber >= from &&
					event.blockNumber <= to &&
					(!accounts?.length || accounts.some((account) => account.toString() === event.account.toString()))
			)
	)
	const services: EventCacheService[] = []
	function create(accounts: EthereumAddress[]) {
		const service = new EventCacheService(storage, contract, {
			...defaultLightClientEventCacheServiceConfig,
			specificAccountsOnly: accounts,
			pollingIntervalMs: 60000,
		})
		services.push(service)
		return service
	}
	t.after(() => {
		for (const service of services) service.stop()
		contract.stop()
	})
	async function readSecond(service: EventCacheService) {
		const records = await service.getLeafRecordsForAccount(second, 10, 11)
		assert.deepEqual(
			records.map((record) => [record.account.toString(), record.leafIndex, [...record.payload]]),
			[
				[second.toString(), 0, [2]],
				[second.toString(), 1, [3]],
			]
		)
	}
	async function tick() {
		const callback = intervals.mock.calls[intervals.mock.calls.length - 1]?.arguments[0]
		assert.ok(typeof callback === "function")
		await callback()
	}
	return {
		storage,
		first,
		second,
		third,
		logs,
		getLogs,
		create,
		readSecond,
		tick,
		setHead: (value: number) => {
			head = value
		},
	}
}

describe("event cache account coverage", { concurrency: false, timeout: 5000 }, () => {
	test("a polling cache supports expanded monitoring, empty account results, and unfiltered prefetch", async (t) => {
		const f = fixture(t)
		const narrow = f.create([f.first])
		await narrow.start()
		f.setHead(11)
		await f.tick()
		narrow.stop()
		const narrowCalls = f.getLogs.mock.callCount()
		assert.equal((await narrow.getLeafRecordsForAccount(f.first, 10, 10)).length, 1)
		assert.deepEqual(await narrow.getLeafRecordsForAccount(f.first, 11, 11), [])
		assert.equal(f.getLogs.mock.callCount(), narrowCalls)

		const expanded = f.create([f.first, f.second])
		await f.readSecond(expanded)
		const unfiltered = f.create([])
		await unfiltered.syncEventsUpToLatestBlock()
		const coveredCalls = f.getLogs.mock.callCount()
		assert.equal((await unfiltered.getLeafRecordsForAccount(f.third, 10, 10)).length, 1)
		await f.readSecond(unfiltered)
		await f.readSecond(f.create([f.second]))
		await unfiltered.syncEventsUpToLatestBlock()
		assert.equal(f.getLogs.mock.callCount(), coveredCalls, "Covered reads and prefetch should reuse cached results")
	})

	test("legacy caches support explicit reads outside the monitoring filter and account-specific clearing", async (t) => {
		const f = fixture(t)
		f.setHead(11)
		await putLeafRecordInDB(f.storage, f.first, 0, f.logs[0])
		await f.storage.put(`events:account:${f.first}:block:10`, "[0]")
		// Old markers do not distinguish unfiltered queries from account-specific queries.
		await f.storage.put("events:block:10", JSON.stringify([f.first.toString()]))
		await f.storage.put("events:block:11", "[]")
		const service = f.create([f.first])
		await f.readSecond(service)
		// Clearing one account must also invalidate any later unfiltered coverage.
		f.setHead(11)
		await f.create([]).syncEventsUpToLatestBlock()
		const refreshedCalls = f.getLogs.mock.callCount()
		await f.readSecond(service)
		assert.equal(f.getLogs.mock.callCount(), refreshedCalls)

		await service.clearEventCache({ forAccount: f.second.toString() })
		await f.readSecond(service)
		assert.ok(f.getLogs.mock.callCount() > refreshedCalls, "Cleared account data should be fetched again")
		const reloadedCalls = f.getLogs.mock.callCount()
		await f.readSecond(service)
		assert.equal(f.getLogs.mock.callCount(), reloadedCalls)
		assert.equal(await f.storage.get(`account:${f.first}:leaf:0:payload`), "01")
	})
})
