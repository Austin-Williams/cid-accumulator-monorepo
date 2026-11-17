import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import {
	defaultIpfsPinnerConfig,
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
	defaultLightClientIpfsResolverConfig,
} from "../source/config/defaultConfig.js"
import { DataClient } from "../source/core/dataClient/DataClient.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { IpfsPinner } from "../source/ipfs/IpfsPinner.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import type { CIDDataPair } from "../source/ipfs/types.js"
import { MerkleMountainRange } from "../source/mmr/MerkleMountainRange.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { PinningService } from "../source/services/PinningService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { putLeafRecordInDB } from "../source/storage/utils.js"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => { resolve = done })
	return { promise, resolve }
}

async function fixture(t: TestContext, pause: "sync" | "pin") {
	t.mock.method(console, "log", () => {})
	t.mock.method(console, "warn", () => {})
	t.mock.method(console, "error", () => {})
	const intervals = t.mock.method(globalThis, "setInterval")
	const storage = new InMemoryAdapter()
	const contract = new AccumulatorContract({ ...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: "0x" + "ab".repeat(20) })
	mockChain(t, contract, storage)
	const events = new EventCacheService(storage, contract, defaultLightClientEventCacheServiceConfig)
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	const client = new DataClient({ storage, accumulatorContract: contract, eventCacheService: events, ipfsResolver: resolver })
	client.completedInitialSync = pause !== "sync"
	const subscriptions = t.mock.method(client, "subscribe")
	const entered = deferred()
	const release = deferred()
	if (pause === "sync") t.mock.method(client, "sync", async () => {
		entered.resolve()
		await release.promise
		client.completedInitialSync = true
	})
	const chain = new MerkleMountainRange()
	const expected = new Set<string>()
	t.mock.method(contract, "getRootCID", () => chain.rootCID())
	const pinner = new IpfsPinner(storage, defaultIpfsPinnerConfig)
	t.mock.method(pinner, "init", async () => {})
	const pinned = new Set<string>()
	t.mock.method(pinner, "putAndPin", async (pair: CIDDataPair) => {
		if (pause === "pin") {
			entered.resolve()
			await release.promise
		}
		pinned.add(pair.cid.toString())
	})
	const service = new PinningService(storage, contract, client, pinner, 60000)
	t.after(() => {
		release.resolve()
		service.stop()
		contract.stop()
		events.stop()
		resolver.stop()
	})
	async function append(value: number, notify = false) {
		const payload = new Uint8Array(32).fill(value)
		const leafIndex = chain.leafCount
		for (const pair of await chain.addLeafWithTrail(leafIndex, payload)) expected.add(pair.cid.toString())
		const record = { account: contract.address, leafIndex, payload }
		await putLeafRecordInDB(storage, contract.address, leafIndex, record)
		if (notify) client.onLeafAppended(record)
	}
	async function tick() {
		const callback = intervals.mock.calls.at(-1)?.arguments[0]
		assert.equal(typeof callback, "function")
		await (callback as () => Promise<void>)()
	}
	async function assertPinned() {
		assert.equal(service.mmr.leafCount, chain.leafCount)
		assert.equal((await service.mmr.rootCID()).toString(), (await chain.rootCID()).toString())
		assert.deepEqual(pinned, expected)
	}
	await append(1)
	return { service, client, entered, release, append, tick, assertPinned, pinned, subscriptions, intervals }
}

describe("pinning startup", { concurrency: false, timeout: 5000 }, () => {
	for (const pause of ["sync", "pin"] as const) {
		test(`leaves arriving during initial ${pause} are pinned without duplicate subscriptions`, async (t) => {
			const f = await fixture(t, pause)
			const starting = f.service.start()
			try {
				await f.entered.promise
				await f.append(2, true)
				await f.service.start()
				assert.equal(f.subscriptions.mock.callCount(), 1)
			} finally {
				f.release.resolve()
				await starting
			}
			await f.tick()
			await f.assertPinned()
			assert.equal(f.subscriptions.mock.callCount(), 1)
		})
	}

	test("stop during initial sync disconnects notifications and prevents pinning or polling", async (t) => {
		const f = await fixture(t, "sync")
		const starting = f.service.start()
		try {
			await f.entered.promise
			f.service.stop()
			await f.append(2, true)
		} finally {
			f.release.resolve()
			await starting
		}
		assert.equal(f.service.mmr.leafCount, 0)
		assert.equal(f.pinned.size, 0)
		assert.equal(f.intervals.mock.callCount(), 0)
	})
})
