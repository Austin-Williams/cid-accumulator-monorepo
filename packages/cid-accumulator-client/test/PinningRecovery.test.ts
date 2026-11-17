import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import { setImmediate } from "node:timers/promises"
import {
	defaultIpfsPinnerConfig,
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
	defaultLightClientIpfsResolverConfig,
} from "../source/config/defaultConfig.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import { IpfsPinner } from "../source/ipfs/IpfsPinner.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import type { CIDDataPair } from "../source/ipfs/types.js"
import { MerkleMountainRange } from "../source/mmr/MerkleMountainRange.js"
import type { LeafRecord, MMRLeafAppendedTrail } from "../source/mmr/types.js"
import { DataClient } from "../source/core/dataClient/DataClient.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { PinningService } from "../source/services/PinningService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { putLeafRecordInDB } from "../source/storage/utils.js"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

async function waitFor(check: () => boolean) {
	const deadline = Date.now() + 1000
	while (!check()) {
		assert.ok(Date.now() < deadline, "Timed out waiting for background pinning")
		await setImmediate()
	}
}

function fixture(t: TestContext) {
	t.mock.method(console, "log", () => {})
	t.mock.method(console, "warn", () => {})
	const errors = t.mock.method(console, "error", () => {})
	const intervals = t.mock.method(globalThis, "setInterval")
	const storage = new InMemoryAdapter()
	const account = new EthereumAddress("0x" + "11".repeat(20))
	const contract = new AccumulatorContract({ ...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: account })
	mockChain(t, contract, storage)
	const events = new EventCacheService(storage, contract, defaultLightClientEventCacheServiceConfig)
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	const client = new DataClient({ storage, accumulatorContract: contract, eventCacheService: events, ipfsResolver: resolver })
	client.completedInitialSync = true
	const subscriptions = t.mock.method(client, "subscribe")
	const pinner = new IpfsPinner(storage, defaultIpfsPinnerConfig)
	const chain = new MerkleMountainRange()
	t.mock.method(contract, "getCIDAccumulatorState", async () => {
		const heights = [...chain.leafCount.toString(2)].flatMap((bit, index, bits) =>
			bit === "1" ? [bits.length - index - 1] : []
		)
		return {
			meta: {
				leafCount: chain.leafCount,
				peakCount: heights.length,
				peakHeights: heights,
				previousInsertBlockNumber: chain.leafCount === 0 ? 0 : 100,
				deployBlockNumber: chain.leafCount === 0 ? 0 : 100,
			},
			peaks: chain.peaks.map((cid, index) => ({ cid, height: heights[index] })),
		}
	})
	const attempts: string[] = []
	const pinned = new Set<string>()
	let pinBehavior: (pair: CIDDataPair) => Promise<void> = async () => {}
	t.mock.method(pinner, "putAndPin", async (pair: CIDDataPair, pinAccount: EthereumAddress) => {
		assert.equal(pinAccount.toString(), account.toString())
		attempts.push(pair.cid.toString())
		await pinBehavior(pair)
		pinned.add(pair.cid.toString())
	})
	const service = new PinningService(storage, contract, client, pinner, 60000)
	t.after(() => service.stop())
	const trails: MMRLeafAppendedTrail[] = []
	async function append(payload: Uint8Array, notify = false) {
		const leafIndex = chain.leafCount
		trails.push(await chain.addLeafWithTrail(leafIndex, payload))
		const record: LeafRecord = { account, leafIndex, payload }
		await putLeafRecordInDB(storage, account, leafIndex, record)
		if (notify) client.onLeafAppended(record)
	}
	async function tick() {
		const callback = intervals.mock.calls[intervals.mock.callCount() - 1]?.arguments[0]
		assert.ok(typeof callback === "function", "The periodic retry must be scheduled")
		await callback()
	}
	function liveMMR() {
		const mmr = service.mmr
		assert.ok(mmr)
		return mmr
	}
	async function assertFullyPinned() {
		assert.equal(liveMMR().leafCount, chain.leafCount)
		assert.equal((await liveMMR().rootCID()).toString(), (await chain.rootCID()).toString())
		for (const pair of trails.flat()) assert.ok(pinned.has(pair.cid.toString()), `Missing pin: ${pair.cid}`)
	}
	return {
		service,
		account,
		client,
		chain,
		trails,
		attempts,
		pinned,
		subscriptions,
		errors,
		append,
		tick,
		liveMMR,
		assertFullyPinned,
		setPinBehavior: (behavior: (pair: CIDDataPair) => Promise<void>) => {
			pinBehavior = behavior
		},
	}
}

describe("pinning failure recovery", { concurrency: false, timeout: 5000 }, () => {
	test("initial upload failure stays subscribed and the periodic check retries it", async (t) => {
		const f = fixture(t)
		await f.append(new Uint8Array(32).fill(1))
		f.setPinBehavior(async () => {
			throw new Error("IPFS offline")
		})
		await f.service.start()
		assert.equal(f.liveMMR().leafCount, 0)
		assert.equal(f.pinned.size, 0)
		assert.equal(f.subscriptions.mock.callCount(), 1)
		assert.equal(await f.service.verifyRootCIDs(), false)

		f.setPinBehavior(async () => {})
		await f.tick()
		await f.assertFullyPinned()
		await f.service.sync()
		assert.equal(f.subscriptions.mock.callCount(), 1)
		await f.append(new Uint8Array(32).fill(2), true)
		await waitFor(() => f.liveMMR().leafCount === 2)
		await f.assertFullyPinned()
	})

	test("a failure midway through a leaf's blocks preserves the previous peaks and retries that leaf", async (t) => {
		const f = fixture(t)
		for (let i = 1; i <= 4; i++) await f.append(new Uint8Array(32).fill(i))
		const failedCID = f.trails[3][1].cid.toString()
		const previousRoot = f.trails[2][f.trails[2].length - 1].cid.toString()
		f.setPinBehavior(async (pair) => {
			if (pair.cid.toString() === failedCID) throw new Error("Intermediate block upload failed")
		})
		await f.service.start()
		assert.equal(f.liveMMR().leafCount, 3)
		assert.equal((await f.liveMMR().rootCID()).toString(), previousRoot)
		assert.equal(f.liveMMR().peaks.length, 2)
		assert.ok(f.pinned.has(f.trails[3][0].cid.toString()))
		assert.equal(f.pinned.has(failedCID), false)
		assert.equal(await f.service.verifyRootCIDs(), false)

		let committedLeaves = 0
		f.liveMMR().subscribeToLeafAppendedTrail(() => {
			committedLeaves++
		})
		f.setPinBehavior(async () => {})
		await f.tick()
		await f.assertFullyPinned()
		assert.equal(committedLeaves, 1)
		assert.equal(f.attempts.filter((cid) => cid === f.trails[0][0].cid.toString()).length, 1)
	})

	test("progress waits for the last pin and concurrent triggers do not duplicate the append", async (t) => {
		const f = fixture(t)
		await f.service.start()
		await f.append(new Uint8Array(32).fill(1))
		await f.append(new Uint8Array(32).fill(2))
		const entered = deferred()
		const release = deferred()
		const finalCID = f.trails[1][1].cid.toString()
		f.setPinBehavior(async (pair) => {
			if (pair.cid.toString() === finalCID) {
				entered.resolve()
				await release.promise
			}
		})
		const tracking = f.service.sync()
		try {
			await entered.promise
			assert.equal(f.liveMMR().leafCount, 1)
			assert.equal(await f.service.verifyRootCIDs(), false)
			await Promise.all([f.service.sync(), f.tick()])
			assert.equal(f.attempts.filter((cid) => cid === finalCID).length, 1)
			assert.equal(f.subscriptions.mock.callCount(), 1)
		} finally {
			release.resolve()
			await tracking
		}
		await f.assertFullyPinned()
	})

	test("event-triggered failures are handled and later events can recover the backlog", async (t) => {
		const f = fixture(t)
		await f.append(new Uint8Array(32).fill(1))
		await f.service.start()
		f.setPinBehavior(async () => {
			throw new Error("IPFS temporarily offline")
		})
		const errorsBefore = f.errors.mock.callCount()
		await f.append(new Uint8Array(32).fill(2), true)
		await waitFor(() => f.errors.mock.callCount() > errorsBefore)
		assert.equal(f.liveMMR().leafCount, 1)

		f.setPinBehavior(async () => {})
		await f.append(new Uint8Array(32).fill(3), true)
		await waitFor(() => f.liveMMR().leafCount === 3)
		await f.assertFullyPinned()
		assert.equal(f.subscriptions.mock.callCount(), 1)
	})

	test("a failed data sync permits a later pin attempt", async (t) => {
		const f = fixture(t)
		await f.append(new Uint8Array(32).fill(1))
		f.client.completedInitialSync = false
		let offline = true
		t.mock.method(f.client, "sync", async () => {
			if (offline) throw new Error("RPC offline")
			f.client.completedInitialSync = true
		})
		await f.service.start()
		assert.equal(f.liveMMR().leafCount, 0)
		assert.equal(f.attempts.length, 0)
		assert.equal(f.subscriptions.mock.callCount(), 1)
		offline = false
		await f.tick()
		await f.assertFullyPinned()
	})

	test("an old upload completing after restart cannot advance or unlock the new run", async (t) => {
		const f = fixture(t)
		await f.service.start()
		await f.append(new Uint8Array(32).fill(1))
		const firstEntered = deferred()
		const secondEntered = deferred()
		const firstRelease = deferred()
		const secondRelease = deferred()
		let calls = 0
		f.setPinBehavior(async () => {
			if (++calls === 1) {
				firstEntered.resolve()
				await firstRelease.promise
			} else {
				secondEntered.resolve()
				await secondRelease.promise
			}
		})
		const first = f.service.sync()
		let second: Promise<void> | undefined
		try {
			await firstEntered.promise
			f.service.stop()
			second = f.service.start()
			await secondEntered.promise
			firstRelease.resolve()
			await first
			assert.equal(f.liveMMR().leafCount, 0)
			await f.service.sync()
			assert.equal(calls, 2)
		} finally {
			firstRelease.resolve()
			secondRelease.resolve()
			await Promise.all([first, second])
		}
		await f.assertFullyPinned()
		assert.equal(f.subscriptions.mock.callCount(), 2)
	})
})
