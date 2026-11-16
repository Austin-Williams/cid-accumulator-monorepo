import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import {
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
} from "../source/config/defaultConfig.js"
import { DataClient } from "../source/core/dataClient/DataClient.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import type { NormalizedLeafAppendedEvent } from "../source/ethereum/events.types.js"
import { CarReader } from "../source/ipfs/CarReader.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import type { CIDDataPair, DagCborEncodedData } from "../source/ipfs/types.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { encodeBlock, uint8ArrayToHexString } from "../source/utils/codec.js"
import * as dagCbor from "../source/utils/dagCbor.js"

function varint(value: number): Uint8Array {
	const bytes: number[] = []
	do {
		const byte = value % 128
		value = Math.floor(value / 128)
		bytes.push(byte | (value > 0 ? 0x80 : 0))
	} while (value > 0)
	return Uint8Array.from(bytes)
}

// CAR v1 framing, with the requested root declared independently of the included blocks.
function makeCar(root: CIDDataPair, blocks: CIDDataPair[]): Uint8Array {
	const header = dagCbor.encode({ roots: [root.cid], version: 1 })
	const parts = [varint(header.length), header]
	for (const block of blocks) {
		parts.push(
			varint(block.cid.bytes.length + block.dagCborEncodedData.length),
			block.cid.bytes,
			block.dagCborEncodedData
		)
	}
	return Buffer.concat(parts)
}

async function fixture(t: TestContext, gatewayUrl = "https://ipfs.example.test", maxRetries = 0) {
	t.mock.method(console, "log", () => {})
	t.mock.method(console, "warn", () => {})
	t.mock.method(console, "error", () => {})
	const left = await encodeBlock(Uint8Array.of(1))
	const right = await encodeBlock(Uint8Array.of(2))
	const last = await encodeBlock(Uint8Array.of(3))
	const branch = await encodeBlock({ L: left.cid, R: right.cid })
	const root = await encodeBlock({ L: branch.cid, R: last.cid })
	const blocks = [root, branch, left, right, last]
	const storage = new InMemoryAdapter()
	const resolver = new IpfsResolver(storage, {
		gatewayUrl,
		rateLimiterOptions: { intervalMs: 0, maxRetries, baseDelay: 0, capDelay: 0 },
	})
	let car: Uint8Array | undefined
	const rawBlocks = new Map<string, Uint8Array>()
	const requests: URL[] = []
	const fetch = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(input instanceof Request ? input.url : input.toString())
		requests.push(url)
		const bytes = url.searchParams.get("format") === "car" ? car : rawBlocks.get(url.pathname.split("/").pop()!)
		return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 })
	})
	t.after(() => resolver.stop())
	return {
		left,
		right,
		last,
		branch,
		root,
		blocks,
		storage,
		resolver,
		fetch,
		requests,
		rawBlocks,
		setCar: (included: CIDDataPair[]) => {
			car = makeCar(root, included)
		},
		cache: async (cached: CIDDataPair[]) => {
			for (const block of cached) {
				await storage.put(`ipfs:block:${block.cid}`, uint8ArrayToHexString(block.dagCborEncodedData))
			}
		},
	}
}

async function collect(result: Awaited<ReturnType<IpfsResolver["fullyResolveCID"]>>) {
	assert.ok(result, "The complete tree should resolve")
	const payloads = []
	for await (const { leafIndex, payload } of result) {
		payloads.push({ index: leafIndex, payload: uint8ArrayToHexString(payload) })
	}
	return payloads
}

const expectedPayloads = [
	{ index: 0, payload: "01" },
	{ index: 1, payload: "02" },
	{ index: 2, payload: "03" },
]

describe("complete IPFS tree resolution", { concurrency: false, timeout: 5000 }, () => {
	test("CAR parsing checks unsigned lengths, framing, and header structure", async () => {
		assert.equal(dagCbor.decode(dagCbor.encode(0xffffffff)), 0xffffffff)
		const truncatedValues = [
			[0x1a, 0x00], // Incomplete four-byte argument.
			[0x5a, 0xff, 0xff, 0xff, 0xff], // Bytes cannot have a negative length.
			[0x9a, 0xff, 0xff, 0xff, 0xff], // Nor can array or map counts.
			[0xba, 0xff, 0xff, 0xff, 0xff],
			[0x82, 0x7a, 0xff, 0xff, 0xff, 0xfb], // A text length must not move the cursor backward.
		]
		for (const bytes of truncatedValues) {
			assert.throws(() => dagCbor.decode(Uint8Array.from(bytes) as DagCborEncodedData), /Unexpected end of data/)
		}

		const root = await encodeBlock(Uint8Array.of(1))
		const headerOnly = makeCar(root, [])
		const invalidCars = [
			Uint8Array.of(0x80), // Truncated length varint.
			varint(Number.MAX_SAFE_INTEGER + 1),
			Buffer.concat([varint(2 ** 32), headerOnly]), // Must not wrap around to a small length.
			headerOnly.slice(0, -1),
			Buffer.concat([headerOnly, varint(4), Uint8Array.of(1)]), // Truncated block.
			...[[], { version: 2, roots: [] }, { version: 1, roots: [1] }].map((header) => {
				const bytes = dagCbor.encode(header)
				return Buffer.concat([varint(bytes.length), bytes])
			}),
		]
		for (const car of invalidCars) await assert.rejects(CarReader.fromBytes(car))
	})

	test("a complete cached tree resolves without gateway requests", async (t) => {
		const { blocks, root, resolver, cache, requests } = await fixture(t)
		await cache(blocks)
		assert.deepEqual(await collect(await resolver.fullyResolveCID(root.cid)), expectedPayloads)
		assert.equal(requests.length, 0)
	})

	for (const missing of ["left", "right", "last"] as const) {
		test(`a cached tree missing the ${missing} leaf remains unresolved`, async (t) => {
			const f = await fixture(t)
			await f.cache(f.blocks.filter((block) => block !== f[missing]))
			assert.equal(await f.resolver.fullyResolveCID(f.root.cid), undefined)
			assert.equal(f.requests[0].searchParams.get("format"), "car")
			assert.ok(f.requests.some((url) => url.pathname === `/ipfs/${f[missing].cid}` && !url.search))
		})
	}

	for (const order of ["parents first", "children first", "mixed"] as const) {
		test(`a complete CAR resolves with blocks in ${order} order`, async (t) => {
			const f = await fixture(t)
			await f.cache([f.root])
			const orders = {
				"parents first": f.blocks,
				"children first": [f.left, f.right, f.branch, f.last, f.root],
				mixed: [f.last, f.branch, f.right, f.root, f.left],
			}
			f.setCar(orders[order])
			assert.deepEqual(await collect(await f.resolver.fullyResolveCID(f.root.cid)), expectedPayloads)
			assert.equal(f.requests.length, 1, "Only the CAR download should be needed")
			assert.equal(f.requests[0].searchParams.get("format"), "car")
		})
	}

	for (const missing of ["all blocks", "root", "branch", "right"] as const) {
		test(`a CAR missing ${missing} does not report the requested root resolved`, async (t) => {
			const f = await fixture(t)
			f.setCar(missing === "all blocks" ? [] : f.blocks.filter((block) => block !== f[missing]))
			assert.equal(await f.resolver.fullyResolveCID(f.root.cid), undefined)
			assert.equal(f.requests.length, 2, "An incomplete CAR should trigger individual block fallback")
			assert.equal(f.requests[1].pathname, `/ipfs/${f.root.cid}`)
			assert.equal(f.requests[1].search, "")
			for (const block of f.blocks) {
				assert.equal(await f.storage.get(`ipfs:block:${block.cid}`), undefined)
			}
		})
	}

	test("a CAR containing a block with the wrong hash is rejected before caching", async (t) => {
		const f = await fixture(t)
		f.setCar(
			f.blocks.map((block) => (block === f.left ? { ...block, dagCborEncodedData: f.right.dagCborEncodedData } : block))
		)
		assert.equal(await f.resolver.fullyResolveCID(f.root.cid), undefined)
		assert.equal(await f.storage.get(`ipfs:block:${f.left.cid}`), undefined)
	})

	test("an incomplete CAR can fall back to individual blocks before yielding payloads", async (t) => {
		const f = await fixture(t, "https://ipfs.example.test/gateway/?token=a%2Bb%2Fc%3D&format=raw", 1)
		f.setCar([f.root, f.branch])
		for (const block of f.blocks) f.rawBlocks.set(block.cid.toString(), block.dagCborEncodedData)
		// The first individual block request fails, then the gateway recovers.
		f.fetch.mock.mockImplementationOnce(async (input: string | URL | Request) => {
			f.requests.push(new URL(input instanceof Request ? input.url : input.toString()))
			return new Response(null, { status: 503 })
		}, 1)
		const result = await f.resolver.fullyResolveCID(f.root.cid)
		assert.equal(f.requests[0].pathname, `/gateway/ipfs/${f.root.cid}`)
		assert.deepEqual(f.requests[0].searchParams.getAll("format"), ["car"])
		const blockRequests = f.requests.filter((url) => url.searchParams.get("format") === "raw")
		assert.equal(blockRequests.length, f.blocks.length + 1, "One retry should recover the failed block request")
		assert.equal(blockRequests.filter((url) => url.pathname === `/gateway/ipfs/${f.root.cid}`).length, 2)
		for (const url of f.requests) {
			assert.ok(url.pathname.startsWith("/gateway/ipfs/"))
			assert.equal(url.searchParams.get("token"), "a+b/c=")
		}
		assert.deepEqual(await collect(result), expectedPayloads)
		assert.deepEqual(await f.resolver.getBlock(f.root.cid, true), f.root.dagCborEncodedData)
	})

	test("a client with a partial cached tree syncs successfully from contract events", async (t) => {
		const f = await fixture(t)
		await f.cache([f.root])
		const account = new EthereumAddress("0x" + "11".repeat(20))
		const contract = new AccumulatorContract({ ...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: "0x" + "ab".repeat(20) })
		mockChain(t, contract, f.storage)
		t.mock.method(contract, "getSingletonBirthdayBlockNum", async () => 1)
		t.mock.method(contract, "getState", async () => ({
			meta: { leafCount: 3, peakCount: 2, peakHeights: [1, 0], previousInsertBlockNumber: 3, deployBlockNumber: 1 },
			peaks: [
				{ cid: f.branch.cid, height: 1 },
				{ cid: f.last.cid, height: 0 },
			],
		}))
		const events: NormalizedLeafAppendedEvent[] = expectedPayloads.map(({ index }) => ({
			account,
			leafIndex: index,
			payload: Uint8Array.of(index + 1),
			blockNumber: index + 1,
			previousInsertBlockNumber: index,
			mergeLeftHashes: index === 1 ? [f.left.cid] : [],
		}))
		const getLogs = t.mock.method(contract, "getLeafAppendedLogs", async (from: number, to: number) =>
			events.filter((event) => event.blockNumber >= from && event.blockNumber <= to)
		)
		const eventCacheService = new EventCacheService(f.storage, contract, defaultLightClientEventCacheServiceConfig)
		const client = new DataClient(account, {
			storage: f.storage,
			accumulatorContract: contract,
			eventCacheService,
			ipfsResolver: f.resolver,
		})
		t.after(() => {
			eventCacheService.stop()
			contract.stop()
		})

		await client.sync()
		assert.equal(client.completedInitialSync, true)
		assert.equal(client.syncing, false)
		assert.deepEqual(await client.getPayloadInRange(0, 2), expectedPayloads)
		assert.deepEqual(
			getLogs.mock.calls.map((call) => call.arguments.slice(0, 2)),
			[
				[3, 3],
				[2, 2],
				[1, 1],
			]
		)
	})
})
