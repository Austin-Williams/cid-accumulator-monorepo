import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { createLightClient } from "../source/core/lightClient/createLightClient.js"
import type { BlockReference, NormalizedDataAppendedEvent } from "../source/ethereum/events.types.js"
import type { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import type { CIDDataPair } from "../source/ipfs/types.js"
import { MerkleMountainRange } from "../source/mmr/MerkleMountainRange.js"
import { encodeBlock } from "../source/utils/codec.js"
import { makeCar } from "./carFixture.js"
import { mockChain } from "./mockChain.js"

async function tree(account: EthereumAddress, entries: Array<[number, number]>) {
	const mmr = new MerkleMountainRange()
	const blocks = new Map<string, CIDDataPair>()
	const roots: string[] = []
	const cars = new Map<string, Uint8Array>()
	const events: NormalizedDataAppendedEvent[] = []
	for (const [byte, blockNumber] of entries) {
		const payload = Uint8Array.of(byte)
		const leafIndex = mmr.leafCount
		const oldPeaks = mmr.peaks.slice()
		for (const block of await mmr.addLeafWithTrail(leafIndex, payload)) blocks.set(block.cid.toString(), block)
		const mergeCount = oldPeaks.length + 1 - mmr.peaks.length
		events.push({ account, blockNumber, leafIndex, payload, mergeLeftHashes: oldPeaks.slice(oldPeaks.length - mergeCount).reverse(),
			previousInsertBlockNumber: events.at(-1)?.blockNumber ?? 0 })
		const root = (await mmr.rootCID()).toString()
		roots.push(root)
		cars.set(root, makeCar(blocks.get(root)!, [...blocks.values()]))
	}
	const heights = Array.from({ length: 32 }, (_, n) => 31 - n).filter(n => (mmr.leafCount >>> n) & 1)
	return { events, roots, cars, state: {
		meta: { leafCount: mmr.leafCount, peakCount: mmr.peaks.length, peakHeights: heights,
			deployBlockNumber: events[0]?.blockNumber ?? 0, previousInsertBlockNumber: events.at(-1)?.blockNumber ?? 0 },
		peaks: mmr.peaks.map((cid, i) => ({ cid, height: heights[i] })),
	} }
}

async function fixture(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "cid-root-start-"))
	const interval = 120_001
	const timers = t.mock.method(globalThis, "setTimeout")
	const calls: string[] = []
	const client = await createLightClient({
		nodeDbPath: join(dir, "client.json"),
		accumulatorContractConfig: { accumulatorContractAddress: "0x" + "11".repeat(20) },
		eventCacheServiceConfig: { pollingIntervalMs: interval },
	})
	t.after(async () => {
		client.stop()
		await client.storage.persist()
		await rm(dir, { force: true, recursive: true })
	})
	const contract = client.accumulatorContract
	mockChain(t, contract)
	t.mock.method(contract, "getChainId", async () => { calls.push("chainId"); return 1n })
	let canonical = await tree(client.account, [])
	const state = t.mock.method(contract, "getCIDAccumulatorState", async (block: BlockReference = "latest") => {
		calls.push(typeof block === "string" ? block : "pinned")
		return canonical.state
	})
	const logs = t.mock.method(contract, "getDataAppendedLogs", async (from: number, to: number) => {
		assert.equal(from, to)
		calls.push("logs " + from)
		return canonical.events.filter(e => e.blockNumber === from)
	})
	const available = new Map<string, Uint8Array>()
	const gateway = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input))
		const root = url.pathname.split("/").pop()!
		calls.push(url.searchParams.get("format") + " " + root)
		const car = available.get(root)
		return car ? new Response(Buffer.from(car)) : new Response(null, { status: 404 })
	})
	async function replace(entries: Array<[number, number]>) {
		canonical = await tree(client.account, entries)
		return canonical
	}
	async function firstPoll() {
		const timer = timers.mock.calls.findLast(call => call.arguments[1] === interval)
		assert.ok(timer)
		await (timer.arguments[0] as () => Promise<void>)()
	}
	return { client, calls, state, logs, gateway, replace, available, firstPoll }
}

test("a seeded root needs only the contract state and one CAR through startup and public reads", async t => {
	const f = await fixture(t)
	const { roots, cars } = await f.replace([[1, 10], [2, 20]])
	f.available.set(roots[1], cars.get(roots[1])!)
	await f.client.init()
	await Promise.all([f.client.start(), f.client.start()])
	assert.equal(f.client.completedInitialSync, true)
	assert.equal(await f.client.getHighestIndex(), 1)
	assert.equal(await f.client.getPayload(1), "02")
	const expected = [{ index: 0, payload: "01" }, { index: 1, payload: "02" }]
	assert.deepEqual(await f.client.getPayloadInRange(0, 10), expected)
	assert.deepEqual(await Array.fromAsync(f.client.iterate()), expected)
	assert.deepEqual(f.calls, ["latest", "car " + roots[1]])
})

test("a CAR miss goes straight to the insertion block and reuses its logs for adjacent appends", async t => {
	const f = await fixture(t)
	const { roots, cars } = await f.replace([[1, 10], [2, 88], [3, 88]])
	f.available.set(roots[0], cars.get(roots[0])!)
	await f.client.start()
	assert.deepEqual(f.calls, ["latest", "car " + roots[2], "logs 88", "car " + roots[1], "car " + roots[0]])
	assert.deepEqual((await f.client.getPayloadInRange(0, 2)).map(v => v.payload), ["01", "02", "03"])
	f.client.stop()
	f.calls.length = 0
	f.available.clear()
	await f.client.start()
	assert.deepEqual(f.calls, ["latest"])
})

test("an empty root needs only the state, and the first live poll delivers the first append", async t => {
	const f = await fixture(t)
	await f.client.start()
	assert.equal(await f.client.getHighestIndex(), -1)
	assert.deepEqual(f.calls, ["latest"])
	const observed: string[] = []
	f.client.subscribe(e => { if (e.type === "append") observed.push(String(e.record.leafIndex)) })
	await f.replace([[7, 90]])
	await f.firstPoll()
	assert.deepEqual(observed, ["0"])
	assert.equal(await f.client.getPayload(0), "07")
})

test("start shares an already requested initial sync", async t => {
	const f = await fixture(t)
	const empty = await f.replace([])
	let release!: () => void
	const pending = new Promise<void>(resolve => { release = resolve })
	f.state.mock.mockImplementationOnce(async () => { await pending; return empty.state })
	const sync = f.client.sync()
	const start = f.client.start()
	release()
	await Promise.all([start, sync])
	assert.equal(f.state.mock.callCount(), 1)
	assert.equal(f.client.completedInitialSync, true)
})

test("the first live poll rolls back a replaced prefix before notifying its replacement", async t => {
	const f = await fixture(t)
	const before = await f.replace([[1, 10], [2, 90], [3, 90]])
	f.available.set(before.roots[2], before.cars.get(before.roots[2])!)
	await f.client.start()
	const observed: string[] = []
	f.client.subscribe(e => observed.push(e.type === "rollback" ? "rollback " + e.firstInvalidLeafIndex : "append " + e.record.leafIndex))
	await f.replace([[1, 10], [9, 91]])
	await f.client.sync()
	await f.firstPoll()
	assert.deepEqual(observed, ["rollback 1", "append 1"])
	assert.deepEqual((await f.client.getPayloadInRange(0, 8)).map(v => v.payload), ["01", "09"])
})

test("a replacement during numbered log lookup retries the contract state and exposes only the verified branch", async t => {
	const f = await fixture(t)
	await f.replace([[1, 80]])
	f.logs.mock.mockImplementationOnce(async () => (await f.replace([[2, 80]])).events)
	await f.client.start()
	assert.equal(f.state.mock.callCount(), 2)
	assert.equal(await f.client.getPayload(0), "02")
})

test("legacy indexed payloads are reusable only if their reconstructed root matches the contract", async t => {
	const f = await fixture(t)
	const { roots, cars } = await f.replace([[1, 80]])
	const key = `account:${f.client.account}:leaf:0:payload`
	await f.client.storage.put(key, "02")
	f.calls.length = 0
	f.available.set(roots[0], cars.get(roots[0])!)
	await f.client.start()
	assert.deepEqual(f.calls, ["latest", "car " + roots[0]])
	assert.equal(await f.client.getPayload(0), "01")
	await f.firstPoll()
	assert.equal(await f.client.storage.get(key), "01")
})

test("a matching legacy payload cache needs only the latest state request", async t => {
	const f = await fixture(t)
	await f.replace([[1, 80]])
	await f.client.storage.put(`account:${f.client.account}:leaf:0:payload`, "01")
	f.calls.length = 0
	await f.client.start()
	assert.equal(await f.client.getPayload(0), "01")
	assert.deepEqual(f.calls, ["latest"])
})

test("mismatched log payloads never become a synced snapshot", async t => {
	const f = await fixture(t)
	const before = await f.replace([[1, 80]])
	f.logs.mock.mockImplementation(async () => [{ ...before.events[0], payload: Uint8Array.of(2) }])
	await assert.rejects(f.client.start(), /do not match the contract/)
	assert.equal(f.client.completedInitialSync, false)
	assert.equal(f.client.running, false)
})

test("a raw-only gateway can recover data after the insertion log request fails", async t => {
	const f = await fixture(t)
	const { roots } = await f.replace([[4, 70]])
	const leaf = await encodeBlock(Uint8Array.of(4))
	f.logs.mock.mockImplementation(async () => { f.calls.push("logs 70"); throw new Error("logs unavailable") })
	f.gateway.mock.mockImplementation(async (input: string | URL | Request) => {
		const format = new URL(String(input)).searchParams.get("format")
		f.calls.push(format + " " + roots[0])
		return format === "raw" ? new Response(Buffer.from(leaf.dagCborEncodedData)) : new Response(null, { status: 406 })
	})
	await f.client.start()
	assert.deepEqual(f.calls, ["latest", "car " + roots[0], "logs 70", "raw " + roots[0]])
	assert.equal(await f.client.getPayload(0), "04")
})

test("stopping during the CAR request suppresses the walkback and live polling", async t => {
	const f = await fixture(t)
	await f.replace([[1, 80]])
	let entered!: () => void
	const fetching = new Promise<void>(resolve => { entered = resolve })
	let respond!: (value: Response) => void
	f.gateway.mock.mockImplementationOnce(async () => { entered(); return new Promise(resolve => { respond = resolve }) })
	const start = f.client.start()
	await fetching
	f.client.stop()
	respond(new Response(null, { status: 404 }))
	await start
	assert.deepEqual(f.calls, ["latest"])
	assert.equal(f.client.completedInitialSync, false)
	assert.equal(f.client.running, false)
})
