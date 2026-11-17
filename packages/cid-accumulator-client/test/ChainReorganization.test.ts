import assert from "node:assert/strict"
import { test } from "node:test"
import type { TestContext } from "node:test"
import { setImmediate } from "node:timers/promises"
import {
	defaultIpfsPinnerConfig,
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
	defaultLightClientIpfsResolverConfig,
} from "../source/config/defaultConfig.js"
import { LightClient } from "../source/core/lightClient/LightClient.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import type { BlockReference, ChainBlock, NormalizedLeafAppendedEvent } from "../source/ethereum/events.types.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import { IpfsPinner } from "../source/ipfs/IpfsPinner.js"
import { MerkleMountainRange } from "../source/mmr/MerkleMountainRange.js"
import { getRootCIDFromPeaks } from "../source/mmr/utils.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { PinningService } from "../source/services/PinningService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"

type State = Awaited<ReturnType<AccumulatorContract["getState"]>>
type BranchBlock = { block: ChainBlock; payloads: number[]; state: State; logs: NormalizedLeafAppendedEvent[] }

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

const payloadBytes = (value: number) => new Uint8Array(32).fill(value)
const payloadHex = (value: number) => value.toString(16).padStart(2, "0").repeat(32)

async function fixture(t: TestContext, startEmpty = false) {
	t.mock.method(console, "log", () => {})
	t.mock.method(console, "warn", () => {})
	t.mock.method(console, "error", () => {})
	const timers = t.mock.method(globalThis, "setInterval", (() => 0) as any)
	const account = new EthereumAddress("0x" + "ab".repeat(20))
	const storage = new InMemoryAdapter()
	t.mock.method(storage, "stop", () => {})
	const contract = new AccumulatorContract({ ...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: "0x" + "ab".repeat(20) })
	let nextHash = 1
	const hash = () => "0x" + (nextHash++).toString(16).padStart(64, "0")
	const genesis: BranchBlock = {
		block: { number: 0, hash: hash(), parentHash: "0x" + "00".repeat(32) },
		payloads: [],
		logs: [],
		state: {
			meta: { leafCount: 0, peakCount: 0, peakHeights: [], previousInsertBlockNumber: 0, deployBlockNumber: 0 },
			peaks: [],
		},
	}
	const history = new Map<string, BranchBlock>([[genesis.block.hash, genesis]])
	let tip = genesis
	function canonical(number: number): BranchBlock {
		let cursor = tip
		if (number > cursor.block.number) throw new Error("Block not found")
		while (cursor.block.number > number) cursor = history.get(cursor.block.parentHash)!
		return cursor
	}
	async function append(payload: number | undefined, parent = tip): Promise<BranchBlock> {
		const payloads = payload === undefined ? [...parent.payloads] : [...parent.payloads, payload]
		const mmr = new MerkleMountainRange()
		for (const [index, value] of parent.payloads.entries()) await mmr.addLeafWithTrail(index, payloadBytes(value))
		const previousPeaks = [...mmr.peaks]
		if (payload !== undefined) await mmr.addLeafWithTrail(parent.payloads.length, payloadBytes(payload))
		const heights = [...payloads.length.toString(2)].flatMap((bit, index, bits) =>
			bit === "1" ? [bits.length - index - 1] : []
		)
		const block = { number: parent.block.number + 1, hash: hash(), parentHash: parent.block.hash }
		const mergeCount = previousPeaks.length + (payload === undefined ? 0 : 1) - mmr.peaks.length
		const branch: BranchBlock = {
			block,
			payloads,
			state: {
				meta: {
					leafCount: payloads.length,
					peakCount: heights.length,
					peakHeights: heights,
					previousInsertBlockNumber: payload === undefined ? parent.state.meta.previousInsertBlockNumber : block.number,
					deployBlockNumber: parent.state.meta.deployBlockNumber || (payload === undefined ? 0 : block.number),
				},
				peaks: mmr.peaks.map((cid, index) => ({ cid, height: heights[index] })),
			},
			logs: payload === undefined ? [] : [
				{
					account,
					leafIndex: payloads.length - 1,
					payload: payloadBytes(payload!),
					blockNumber: block.number,
					blockHash: block.hash,
					previousInsertBlockNumber: parent.state.meta.previousInsertBlockNumber,
					mergeLeftHashes: previousPeaks.slice(previousPeaks.length - mergeCount).reverse(),
				},
			],
		}
		history.set(block.hash, branch)
		tip = branch
		return branch
	}
	t.mock.method(contract, "getBlockNumber", async () => tip.block.number)
	t.mock.method(
		contract,
		"getBlock",
		async (block: number | "latest" | "finalized") =>
			(typeof block === "number" ? canonical(block) : block === "finalized" ? genesis : tip).block
	)
	t.mock.method(contract, "getBlockByHash", async (hash: string) => history.get(hash)!.block)
	t.mock.method(contract, "getState", async (reference: BlockReference = "latest") => {
		const selected = typeof reference === "object" ? history.get(reference.blockHash)! : tip
		if (typeof reference === "object") assert.equal(canonical(selected.block.number).block.hash, reference.blockHash)
		return selected.state
	})
	t.mock.method(
		contract,
		"getLeafAppendedLogs",
		async (from: number, to: number, blockHash?: string) => {
			if (blockHash) return history.get(blockHash)!.logs
			return Array.from({ length: to - from + 1 }, (_, index) => canonical(from + index).logs).flat()
		}
	)
	const events = new EventCacheService(storage, contract, {
		...defaultLightClientEventCacheServiceConfig,
		pollingIntervalMs: 12345,
	})
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	const resolve = t.mock.method(resolver, "fullyResolveCID", async () => undefined)
	const client = new LightClient({
		storage,
		accumulatorContract: contract,
		eventCacheService: events,
		ipfsResolver: resolver,
	})
	const notifications: string[] = []
	client.subscribe((event) => {
		notifications.push(
			event.type === "rollback"
				? `rollback:${event.firstInvalidLeafIndex}`
				: `append:${event.record.leafIndex}:${event.record.payload[0]}`
		)
	})
	t.after(() => {
		client.stop()
		events.stop()
		resolver.stop()
		contract.stop()
	})
	async function tick() {
		const timer = timers.mock.calls.find((call) => call.arguments[1] === 12345)
		assert.ok(timer)
		const callback = timer.arguments[0] as () => Promise<void>
		await callback()
	}
	const prefix = startEmpty ? genesis : await append(1)
	await client.start()
	notifications.length = 0
	async function startPinning() {
		const pinner = new IpfsPinner(storage, defaultIpfsPinnerConfig)
		t.mock.method(pinner, "init", async () => {})
		t.mock.method(pinner, "putAndPin", async () => {})
		const pinning = new PinningService(storage, contract, client, pinner, 67890)
		t.after(() => {
			pinning.stop()
		})
		await pinning.start()
		return async () => {
			const deadline = Date.now() + 1000
			while (pinning.mmr.leafCount !== tip.payloads.length) {
				assert.ok(Date.now() < deadline, "Pinning should catch up to the replacement branch")
				await setImmediate()
			}
			assert.equal(
				(await pinning.mmr.rootCID()).toString(),
				(await getRootCIDFromPeaks(tip.state.peaks.map((peak) => peak.cid))).toString()
			)
		}
	}
	return {
		account,
		storage,
		contract,
		client,
		events,
		resolve,
		notifications,
		prefix,
		append,
		tick,
		startPinning,
		setTip: (block: BranchBlock) => {
			tip = block
		},
	}
}

test(
	"tip replacement rolls back only the affected suffix, resumes interrupted repair, and handles a shorter chain",
	{ timeout: 5000 },
	async (t) => {
		const f = await fixture(t)
		const assertPinned = await f.startPinning()
		const orphan = await f.append(2)
		await f.tick()
		await assertPinned()
		await f.storage.delete(`account:${f.account}:leaf:1:blockNumber`)
		await f.storage.put(`account:${f.account}:leaf:1:rootCidAfterInsert`, orphan.state.peaks[0].cid.toString())
		f.notifications.length = 0
		await f.append(3, f.prefix)
		await f.tick()
		await f.client.sync()
		await assertPinned()
		assert.deepEqual(f.notifications, ["rollback:1", "append:1:3"])
		assert.deepEqual(await f.client.getPayloadInRange(0, 1), [
			{ index: 0, payload: payloadHex(1) },
			{ index: 1, payload: payloadHex(3) },
		])
		assert.notEqual(
			await f.storage.get(`account:${f.account}:leaf:1:rootCidAfterInsert`),
			orphan.state.peaks[0].cid.toString()
		)

		const remove = f.storage.delete.bind(f.storage)
		let interrupted = false
		t.mock.method(f.storage, "delete", async (key: string) => {
			if (!interrupted && key.startsWith(`account:${f.account}:leaf:1:`)) {
				interrupted = true
				throw new Error("Interrupted rollback")
			}
			await remove(key)
		})
		await f.append(4, f.prefix)
		await f.tick()
		assert.equal(interrupted, true)
		assert.ok(await f.storage.get("chain:recovery"))
		await f.tick()
		await f.client.sync()
		await assertPinned()
		assert.equal(await f.storage.get("chain:recovery"), undefined)
		assert.equal(await f.client.getPayload(1), payloadHex(4))

		f.setTip(f.prefix)
		await f.tick()
		await f.client.sync()
		await assertPinned()
		assert.equal(await f.client.getHighestIndex(), 0)
		assert.equal(await f.client.getPayload(1), undefined)
		await f.append(5)
		await f.append(6)
		await f.tick()
		await f.client.sync()
		await assertPinned()
		assert.deepEqual(await f.client.getPayloadInRange(0, 2), [
			{ index: 0, payload: payloadHex(1) },
			{ index: 1, payload: payloadHex(5) },
			{ index: 2, payload: payloadHex(6) },
		])

		f.client.stop()
		f.notifications.length = 0
		await f.append(7, f.prefix)
		await f.append(8)
		await f.client.start()
		await assertPinned()
		assert.deepEqual(f.notifications, ["rollback:1", "append:1:7", "append:2:8"])
		assert.deepEqual(await f.client.getPayloadInRange(0, 2), [
			{ index: 0, payload: payloadHex(1) },
			{ index: 1, payload: payloadHex(7) },
			{ index: 2, payload: payloadHex(8) },
		])
	}
)

test(
	"an IPFS import from a replaced tip cannot restore orphaned leaves after rollback",
	{ timeout: 5000 },
	async (t) => {
		const f = await fixture(t)
		await f.append(2)
		const entered = deferred()
		const release = deferred()
		f.resolve.mock.mockImplementationOnce(async () => {
			entered.resolve()
			await release.promise
			return {
				async *[Symbol.asyncIterator]() {
					yield { leafIndex: 0, payload: payloadBytes(1) }
					yield { leafIndex: 1, payload: payloadBytes(2) }
				},
			}
		})
		const stale = f.client.sync()
		const result = Promise.allSettled([stale])
		try {
			await entered.promise
			await f.append(3, f.prefix)
			await f.tick()
		} finally {
			release.resolve()
		}
		await result
		await f.client.sync()
		assert.equal(await f.client.getPayload(1), payloadHex(3))
		assert.equal(f.client.completedInitialSync, true)
	}
)

test("an empty accumulator follows its first append and refreshes history after that append is reorganized", { timeout: 5000 }, async (t) => {
	const f = await fixture(t, true)
	const emptyBlock = await f.append(undefined)
	await f.tick()
	await f.events.syncEventsUpToLatestBlock()
	assert.equal(await f.client.getHighestIndex(), -1)

	await f.append(9)
	await f.tick()
	await f.client.sync()
	assert.equal(await f.client.getPayload(0), payloadHex(9))
	assert.equal((await f.contract.getState()).meta.deployBlockNumber, 2)

	await f.append(undefined, emptyBlock)
	await f.tick()
	await f.client.sync()
	assert.equal(await f.client.getHighestIndex(), -1)
	assert.equal((await f.contract.getState()).meta.deployBlockNumber, 0)

	await f.append(10)
	await f.tick()
	await f.client.sync()
	await f.events.syncEventsUpToLatestBlock()
	assert.equal((await f.contract.getState()).meta.deployBlockNumber, 3)
	assert.equal(await f.client.getPayload(0), payloadHex(10))
	assert.deepEqual((await f.events.getLeafRecords(2, 3)).map(event => event.blockNumber), [3])
})
