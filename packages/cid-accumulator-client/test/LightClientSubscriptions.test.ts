import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import { setImmediate } from "node:timers/promises"
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
	const account = new EthereumAddress("0x" + "ab".repeat(20))
	const storage = new InMemoryAdapter()
	// Model a persistent cache across stops so restart tests do not replay historical data.
	t.mock.method(storage, "stop", () => {})
	const contract = new AccumulatorContract({ ...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: account })
	mockChain(t, contract, storage)
	const logs: NormalizedLeafAppendedEvent[] = []
	const chains = new Map<string, { mmr: MerkleMountainRange; lastBlock: number }>()
	let latestBlock = 1
	function chainFor(address: EthereumAddress) {
		let chain = chains.get(address.toString())
		if (!chain) {
			chain = { mmr: new MerkleMountainRange(), lastBlock: 0 }
			chains.set(address.toString(), chain)
		}
		return chain
	}
	const getBlock = t.mock.method(contract, "getBlockNumber", async () => latestBlock)
	const getCIDAccumulatorState = t.mock.method(contract, "getCIDAccumulatorState", async () => {
		const { mmr, lastBlock } = chainFor(account)
		const bits = mmr.leafCount.toString(2)
		const heights = [...bits].flatMap((bit, index) => (bit === "1" ? [bits.length - index - 1] : []))
		return {
			meta: {
				leafCount: mmr.leafCount,
				peakCount: heights.length,
				peakHeights: heights,
				previousInsertBlockNumber: lastBlock,
				deployBlockNumber: logs.find(event => event.account.toString() === account.toString())?.blockNumber ?? 0,
			},
			peaks: mmr.peaks.map((cid, index) => ({ cid, height: heights[index] })),
		}
	})
	const getLogs = t.mock.method(contract, "getLeafAppendedLogs", async (from: number, to: number) =>
		logs.filter((event) => event.account.toString() === account.toString() && event.blockNumber >= from && event.blockNumber <= to)
	)
	const events = new EventCacheService(storage, contract, {
		...defaultLightClientEventCacheServiceConfig,
		lazyLoadEvents,
	})
	const subscriptions = t.mock.method(events, "subscribe")
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	t.mock.method(resolver, "fullyResolveCID", async () => undefined)
	const client = new LightClient({
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
	async function append(payload: Uint8Array, address = account) {
		const chain = chainFor(address)
		const leafIndex = chain.mmr.leafCount
		const previousPeaks = [...chain.mmr.peaks]
		await chain.mmr.addLeafWithTrail(leafIndex, payload)
		const mergeCount = previousPeaks.length + 1 - chain.mmr.peaks.length
		const event: NormalizedLeafAppendedEvent = {
			account: address,
			leafIndex,
			payload,
			blockNumber: ++latestBlock,
			previousInsertBlockNumber: chain.lastBlock,
			mergeLeftHashes: previousPeaks.slice(previousPeaks.length - mergeCount).reverse(),
		}
		chain.lastBlock = latestBlock
		logs.push(event)
		return event
	}
	async function tick() {
		const callback = intervals.mock.calls[intervals.mock.callCount() - 1]?.arguments[0]
		assert.ok(typeof callback === "function", "Event polling should be scheduled")
		callback()
		const deadline = Date.now() + 1000
		while ((await storage.get("events:latestPolledBlock")) !== latestBlock.toString()) {
			assert.ok(Date.now() < deadline, "Timed out waiting for event polling")
			await setImmediate()
		}
	}
	return { client, events, account, getBlock, getCIDAccumulatorState, getLogs, subscriptions, append, tick }
}

describe("light client event subscriptions", { concurrency: false, timeout: 5000 }, () => {
	test("polling forwards the client's account by address value after storing its payload", async (t) => {
		const f = fixture(t)
		const received: LeafRecord[] = []
		const reads: Promise<string | undefined>[] = []
		f.client.subscribe((event) => {
			if (event.type !== "append") return
			received.push(event.record)
			reads.push(f.client.getPayload(event.record.leafIndex))
		})
		await f.client.start()
		await f.append(Uint8Array.of(99), new EthereumAddress("0x" + "22".repeat(20)))
		await f.append(Uint8Array.of(1), new EthereumAddress("0x" + "AB".repeat(20)))
		await f.tick()
		assert.equal(received.length, 1)
		assert.equal(received[0].account.toString(), f.account.toString())
		assert.equal(received[0].leafIndex, 0)
		assert.deepEqual(await Promise.all(reads), ["01"])
	})

	test("subscriptions are connected before startup prefetch can emit events", async (t) => {
		const f = fixture(t, false)
		await f.append(Uint8Array.of(1))
		const received = t.mock.fn()
		f.client.subscribe(received)
		await f.client.start()
		assert.equal(received.mock.callCount(), 1)
		assert.equal(f.client.completedInitialSync, true)
	})

	test("unsubscribing one callback leaves other client subscribers active", async (t) => {
		const f = fixture(t)
		const first = t.mock.fn()
		const second = t.mock.fn()
		const unsubscribe = f.client.subscribe(first)
		f.client.subscribe(second)
		await f.client.start()
		await f.append(Uint8Array.of(1))
		await f.tick()
		unsubscribe()
		unsubscribe()
		await f.append(Uint8Array.of(2))
		await f.tick()
		assert.equal(first.mock.callCount(), 1)
		assert.equal(second.mock.callCount(), 2)
	})

	test("concurrent and repeated starts create only one event subscription", async (t) => {
		const f = fixture(t)
		const received = t.mock.fn()
		f.client.subscribe(received)
		await Promise.all([f.client.start(), f.client.start()])
		await f.client.start()
		await f.append(Uint8Array.of(1))
		await f.tick()
		assert.equal(f.subscriptions.mock.callCount(), 1)
		assert.equal(received.mock.callCount(), 1)
	})

	test("stop detaches only the client's listener and restart delivers each new event once", async (t) => {
		const f = fixture(t)
		const received: number[] = []
		const observed: number[] = []
		f.client.subscribe((event) => { if (event.type === "append") received.push(event.record.leafIndex) })
		const unsubscribeObserver = f.events.subscribe((event) => observed.push(event.leafIndex))
		t.after(unsubscribeObserver)
		await f.client.start()
		await f.append(Uint8Array.of(1))
		await f.tick()
		f.client.stop()
		f.client.stop()
		const whileStopped = await f.append(Uint8Array.of(2))
		await f.events.fetchAndStoreEventsForBlock(whileStopped.blockNumber)
		assert.deepEqual(received, [0])
		assert.deepEqual(observed, [0, 1])
		await f.client.start()
		await f.append(Uint8Array.of(3))
		await f.tick()
		assert.deepEqual(received, [0, 2])
		assert.deepEqual(observed, [0, 1, 2])
	})

	for (const stage of ["initialization", "polling startup", "initial sync"] as const) {
		test(`failure during ${stage} detaches the listener and retry does not duplicate it`, async (t) => {
			const f = fixture(t)
			const received: number[] = []
			f.client.subscribe((event) => { if (event.type === "append") received.push(event.record.leafIndex) })
			const failure = new Error("Startup failed")
			const fail = async () => {
				throw failure
			}
			if (stage === "initialization") t.mock.method(f.events, "init", fail, { times: 1 })
			else if (stage === "polling startup") f.getBlock.mock.mockImplementationOnce(fail)
			else f.getCIDAccumulatorState.mock.mockImplementationOnce(fail)
			await assert.rejects(f.client.start(), (error) => error === failure)
			const afterFailure = await f.append(Uint8Array.of(1))
			await f.events.fetchAndStoreEventsForBlock(afterFailure.blockNumber)
			assert.deepEqual(received, [])
			await f.client.start()
			await f.append(Uint8Array.of(2))
			await f.tick()
			assert.deepEqual(received, [1])
		})
	}

	test("events from an RPC request finishing after stop are not forwarded", async (t) => {
		const f = fixture(t)
		const received = t.mock.fn()
		f.client.subscribe(received)
		await f.client.start()
		const event = await f.append(Uint8Array.of(1))
		const entered = deferred<void>()
		const response = deferred<NormalizedLeafAppendedEvent[]>()
		f.getLogs.mock.mockImplementationOnce(() => {
			entered.resolve()
			return response.promise
		})
		const fetching = f.events.fetchAndStoreEventsForBlock(event.blockNumber)
		try {
			await entered.promise
			f.client.stop()
		} finally {
			response.resolve([event])
			await fetching
		}
		assert.equal(received.mock.callCount(), 0)
		await f.client.start()
		await f.append(Uint8Array.of(2))
		await f.tick()
		assert.equal(received.mock.callCount(), 1)
	})

	test("stop cancels scheduled and in-flight initialization before a clean restart", async (t) => {
		const f = fixture(t)
		const received = t.mock.fn()
		const componentStarts = f.client.spinUpOrder.map((component) => t.mock.method(component, "start"))
		f.client.subscribe(received)
		const starting = f.client.start()
		f.client.stop()
		await starting
		assert.equal(f.subscriptions.mock.callCount(), 0)
		assert.equal(f.client.running, false)
		assert.equal(f.client.initialized, false)

		const entered = deferred<void>()
		const release = deferred<void>()
		const storageInit = t.mock.method(f.client.storage, "init")
		const storageStop = t.mock.method(f.client.storage, "stop")
		storageInit.mock.mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
		})
		const delayedStart = f.client.start()
		try {
			await entered.promise
			f.client.stop()
		} finally {
			release.resolve()
			await delayedStart
		}
		assert.equal(f.client.running, false)
		assert.equal(f.client.initialized, false)
		assert.equal(storageStop.mock.callCount(), 1, "Stop the component whose initialization finished after cancellation")
		for (const start of componentStarts) assert.equal(start.mock.callCount(), 0)
		assert.equal(f.getBlock.mock.callCount(), 0)
		assert.equal(f.getCIDAccumulatorState.mock.callCount(), 0)
		const whileStopped = await f.append(Uint8Array.of(1))
		await f.events.fetchAndStoreEventsForBlock(whileStopped.blockNumber)
		assert.equal(received.mock.callCount(), 0)

		await f.client.start()
		assert.equal(f.client.running, true)
		assert.equal(f.client.initialized, true)
		await f.append(Uint8Array.of(2))
		await f.tick()
		assert.equal(received.mock.callCount(), 1)
		assert.equal(received.mock.calls[0].arguments[0].type, "append")
		assert.equal(received.mock.calls[0].arguments[0].record.leafIndex, 1)
	})

	test("a throwing subscriber does not block other callbacks or later polling", async (t) => {
		const f = fixture(t)
		f.client.subscribe(() => {
			throw new Error("Subscriber failed")
		})
		const received = t.mock.fn()
		f.client.subscribe(received)
		await f.client.start()
		await f.append(Uint8Array.of(1))
		await f.tick()
		await f.append(Uint8Array.of(2))
		await f.tick()
		assert.equal(received.mock.callCount(), 2)
	})
})
