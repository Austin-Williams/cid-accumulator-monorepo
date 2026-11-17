import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import { setImmediate } from "node:timers/promises"
import {
	defaultIpfsPinnerConfig,
	defaultSeederAccumulatorContractConfig,
	defaultSeederEventCacheServiceConfig,
	defaultSeederIpfsResolverConfig,
} from "../source/config/defaultConfig.js"
import { Seeder } from "../source/core/seeder/Seeder.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import type { NormalizedLeafAppendedEvent } from "../source/ethereum/events.types.js"
import { IpfsPinner } from "../source/ipfs/IpfsPinner.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import type { CIDDataPair } from "../source/ipfs/types.js"
import { MerkleMountainRange } from "../source/mmr/MerkleMountainRange.js"
import type { MMRLeafAppendedTrail } from "../source/mmr/types.js"
import { LightClient } from "../source/core/lightClient/LightClient.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { PinningService } from "../source/services/PinningService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

async function waitFor(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 1000
	while (!(await check())) {
		assert.ok(Date.now() < deadline, "Timed out waiting for seeder catch-up")
		await setImmediate()
	}
}

function fixture(t: TestContext) {
	t.mock.method(console, "log", () => {})
	t.mock.method(console, "warn", () => {})
	t.mock.method(console, "error", () => {})
	const intervals = t.mock.method(globalThis, "setInterval")
	const storage = new InMemoryAdapter()
	// Preserve cache across stop/start just as a persistent storage adapter does.
	t.mock.method(storage, "stop", () => {})
	const account = new EthereumAddress("0x" + "ab".repeat(20))
	const contract = new AccumulatorContract({ ...defaultSeederAccumulatorContractConfig, accumulatorContractAddress: "0x" + "ab".repeat(20) })
	mockChain(t, contract, storage)
	const chain = new MerkleMountainRange()
	const logs: NormalizedLeafAppendedEvent[] = []
	const trails: MMRLeafAppendedTrail[] = []
	let head = 1
	function state() {
		const heights = [...chain.leafCount.toString(2)].flatMap((bit, index, bits) =>
			bit === "1" ? [bits.length - index - 1] : []
		)
		return {
			meta: {
				leafCount: chain.leafCount,
				peakCount: heights.length,
				peakHeights: heights,
				previousInsertBlockNumber: logs[logs.length - 1]?.blockNumber ?? 0,
				deployBlockNumber: logs[0]?.blockNumber ?? 0,
			},
			peaks: chain.peaks.map((cid, index) => ({ cid, height: heights[index] })),
		}
	}
	const getState = t.mock.method(contract, "getState", async () => state())
	t.mock.method(contract, "getBlockNumber", async () => head)
	t.mock.method(contract, "getRootCID", () => chain.rootCID())
	const getLogs = t.mock.method(contract, "getLeafAppendedLogs", async (from: number, to: number) =>
		logs.filter((event) => event.blockNumber >= from && event.blockNumber <= to)
	)
	const events = new EventCacheService(storage, contract, {
		...defaultSeederEventCacheServiceConfig,
		pollingIntervalMs: 12345,
	})
	const resolver = new IpfsResolver(storage, defaultSeederIpfsResolverConfig)
	t.mock.method(resolver, "fullyResolveCID", async () => undefined)
	const client = new LightClient({ storage, accumulatorContract: contract, eventCacheService: events, ipfsResolver: resolver })
	const subscriptions = t.mock.method(client, "subscribe")
	const pinner = new IpfsPinner(storage, defaultIpfsPinnerConfig)
	const pinned = new Set<string>()
	const pins = t.mock.method(pinner, "putAndPin", async (pair: CIDDataPair, pinAccount: EthereumAddress) => {
		assert.equal(pinAccount.toString(), account.toString())
		pinned.add(pair.cid.toString())
	})
	const pinning = new PinningService(storage, contract, client, pinner, 67890)
	const seeder = new Seeder({
		storage,
		accumulatorContract: contract,
		eventCacheService: events,
		dataClient: client,
		pinningService: pinning,
	})
	t.after(() => {
		try {
			seeder.stop()
		} finally {
			events.stop()
			client.stop()
			pinning.stop()
			resolver.stop()
			contract.stop()
		}
	})
	async function append(payload: Uint8Array) {
		const leafIndex = chain.leafCount
		const previousPeaks = [...chain.peaks]
		trails.push(await chain.addLeafWithTrail(leafIndex, payload))
		const mergeCount = previousPeaks.length + 1 - chain.peaks.length
		const event: NormalizedLeafAppendedEvent = {
			account,
			leafIndex,
			payload,
			blockNumber: ++head,
			previousInsertBlockNumber: logs[logs.length - 1]?.blockNumber ?? 0,
			mergeLeftHashes: previousPeaks.slice(previousPeaks.length - mergeCount).reverse(),
		}
		logs.push(event)
		return event
	}
	async function tick() {
		const calls = intervals.mock.calls.filter((call) => call.arguments[1] === 12345)
		const callback = calls[calls.length - 1]?.arguments[0]
		assert.ok(typeof callback === "function")
		callback()
		await waitFor(async () => (await storage.get("events:latestPolledBlock")) === String(head))
		await waitFor(() => pinning.mmr.leafCount === chain.leafCount)
	}
	async function assertFullyPinned() {
		const mmr = pinning.mmr
		assert.ok(mmr)
		assert.equal(mmr.leafCount, chain.leafCount)
		assert.equal((await mmr.rootCID()).toString(), (await chain.rootCID()).toString())
		assert.equal(await client.getHighestIndex(), chain.leafCount - 1)
		assert.equal(client.completedInitialSync, true)
		for (const pair of trails.flat()) assert.ok(pinned.has(pair.cid.toString()), `Missing pin: ${pair.cid}`)
	}
	return {
		seeder,
		storage,
		events,
		client,
		getState,
		getLogs,
		state,
		subscriptions,
		intervals,
		pins,
		append,
		tick,
		assertFullyPinned,
	}
}

describe("seeder restart catch-up", { concurrency: false, timeout: 5000 }, () => {
	test("the seeder recovers startup, then catches up and pins downtime leaves on restart", async (t) => {
		const f = fixture(t)
		const initial = await f.append(new Uint8Array(32).fill(1))
		const pinning = f.seeder.dependencies.pinningService
		const forwarded = t.mock.method(f.client, "onLeafAppended")
		const error = new Error("Pinning startup interrupted")
		t.mock.method(pinning, "start", async () => { throw error }, { times: 1 })
		await assert.rejects(f.seeder.start(), (caught) => caught === error)
		assert.equal(f.seeder.running, false)
		assert.equal(f.seeder.initialized, false)
		const forwardedBefore = forwarded.mock.callCount()
		await f.events.fetchAndStoreEventsForBlock(initial.blockNumber)
		assert.equal(forwarded.mock.callCount(), forwardedBefore)
		await f.seeder.start()
		await f.append(new Uint8Array(32).fill(2))
		await f.tick()
		await f.assertFullyPinned()
		f.seeder.stop()
		const missed = await f.append(new Uint8Array(32).fill(3))
		const stateCalls = f.getState.mock.callCount()
		await f.seeder.start()
		await f.assertFullyPinned()
		assert.ok(f.getState.mock.callCount() > stateCalls, "Retained clients need a fresh contract snapshot")
		assert.equal(await f.storage.get("events:latestPolledBlock"), String(missed.blockNumber))
		assert.ok(
			f.getLogs.mock.calls.some(({ arguments: [from, to] }) => from <= missed.blockNumber && to >= missed.blockNumber)
		)
	})

	test("stopping before the first poll still leaves a saved baseline for restart", async (t) => {
		const f = fixture(t)
		const initial = await f.append(new Uint8Array(32).fill(1))
		await f.seeder.start()
		assert.equal(await f.storage.get("events:latestPolledBlock"), String(initial.blockNumber))
		f.seeder.stop()
		const missed = await f.append(new Uint8Array(32).fill(2))
		await f.seeder.start()
		await f.assertFullyPinned()
		assert.equal(await f.storage.get("events:latestPolledBlock"), String(missed.blockNumber))
	})

	test("a retained client resyncs cached data when its polling cursor is absent", async (t) => {
		const f = fixture(t)
		await f.append(new Uint8Array(32).fill(1))
		await f.seeder.start()
		f.seeder.stop()
		await f.storage.delete("events:latestPolledBlock")
		await f.append(new Uint8Array(32).fill(2))
		const stateCalls = f.getState.mock.callCount()
		await f.seeder.start()
		await f.assertFullyPinned()
		assert.equal(f.getState.mock.callCount(), stateCalls + 1)
	})

	test("repeated start calls do not resync or duplicate subscriptions and pin attempts", async (t) => {
		const f = fixture(t)
		await f.append(new Uint8Array(32).fill(1))
		await f.seeder.start()
		const stateCalls = f.getState.mock.callCount()
		const intervalCalls = f.intervals.mock.callCount()
		const pinCalls = f.pins.mock.callCount()
		await Promise.all([f.seeder.start(), f.seeder.start()])
		assert.equal(f.getState.mock.callCount(), stateCalls)
		assert.equal(f.intervals.mock.callCount(), intervalCalls)
		assert.equal(f.pins.mock.callCount(), pinCalls)
		assert.equal(f.subscriptions.mock.callCount(), 1)
		await f.append(new Uint8Array(32).fill(2))
		await f.tick()
		await f.assertFullyPinned()
		assert.equal(f.subscriptions.mock.callCount(), 1)
	})

	test("already cached downtime events are not notified again during restart catch-up", async (t) => {
		const f = fixture(t)
		await f.append(new Uint8Array(32).fill(1))
		await f.seeder.start()
		f.seeder.stop()
		const observed: number[] = []
		const unsubscribe = f.events.subscribe((event) => observed.push(event.leafIndex))
		t.after(unsubscribe)
		const missed = await f.append(new Uint8Array(32).fill(2))
		await f.events.fetchAndStoreEventsForBlock(missed.blockNumber)
		assert.deepEqual(observed, [1])
		await f.seeder.start()
		await f.assertFullyPinned()
		assert.deepEqual(observed, [1])
	})

	test("an older in-flight sync finishes before restart requests a fresh snapshot", async (t) => {
		const f = fixture(t)
		await f.append(new Uint8Array(32).fill(1))
		await f.seeder.start()
		const captured = deferred()
		const release = deferred()
		f.getState.mock.mockImplementationOnce(async () => {
			const state = f.state()
			captured.resolve()
			await release.promise
			return state
		})
		const oldSync = f.client.sync()
		await captured.promise
		f.seeder.stop()
		// An absent cursor isolates retained-client refresh from event-poll catch-up.
		await f.storage.delete("events:latestPolledBlock")
		await f.append(new Uint8Array(32).fill(2))
		const clientEntered = deferred()
		const startClient = f.client.start.bind(f.client)
		t.mock.method(f.client, "start", async () => {
			clientEntered.resolve()
			return startClient()
		})
		const restarting = f.seeder.start()
		try {
			await clientEntered.promise
		} finally {
			release.resolve()
		}
		await oldSync
		await restarting
		await f.assertFullyPinned()
		assert.equal(f.getState.mock.callCount(), 3)
	})
})
