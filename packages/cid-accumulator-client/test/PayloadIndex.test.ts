import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import {
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
	defaultLightClientIpfsResolverConfig,
} from "../source/config/defaultConfig.js"
import { DataClient } from "../source/core/dataClient/DataClient.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { putLeafRecordInDB } from "../source/storage/utils.js"
import { encodeBlock, hexStringToUint8Array } from "../source/utils/codec.js"

function fixture(t: TestContext) {
	const account = new EthereumAddress("0x" + "ab".repeat(20))
	const storage = new InMemoryAdapter()
	const contract = new AccumulatorContract({ ...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: account })
	mockChain(t, contract, storage)
	const events = new EventCacheService(storage, contract, defaultLightClientEventCacheServiceConfig)
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	const client = new DataClient({
		storage,
		accumulatorContract: contract,
		eventCacheService: events,
		ipfsResolver: resolver,
	})
	t.after(() => {
		events.stop()
		resolver.stop()
		contract.stop()
	})
	return {
		account,
		storage,
		client,
		put: (leafIndex: number, hex: string, address = account) =>
			putLeafRecordInDB(storage, address, leafIndex, {
				account: address,
				leafIndex,
				payload: hexStringToUint8Array(hex),
			}),
	}
}

describe("payload slice indexing", () => {
	test("indexes only this account's payloads, excluding metadata even when its prefix matches", async (t) => {
		const f = fixture(t)
		const payload = hexStringToUint8Array("1234beef")
		const block = await encodeBlock(payload)
		await putLeafRecordInDB(f.storage, f.account, 0, {
			account: f.account,
			leafIndex: 0,
			payload,
			payloadCID: block.cid,
			blockNumber: 123456,
			previousInsertBlockNumber: 0,
			mergeLeftHashes: [],
			rootCidAfterInsert: block.cid,
			insertionTrail: [block],
			peaksWithHeightsAfterInsert: [{ cid: block.cid, height: 0 }],
		})
		await f.storage.put(`account:${f.account}:leafIndex:0:rootCidAfterInsert`, block.cid.toString())
		await f.storage.put(`account:${f.account}:leaf:not-an-index:payload`, "1234ffff")
		await f.put(0, "1234aaaa", new EthereumAddress("0x" + "22".repeat(20)))
		assert.deepEqual(await f.client.createIndexByPayloadSlice(0, 4), new Map([["1234", ["1234beef"]]]))
	})

	test("adding event metadata leaves the payload index unchanged", async (t) => {
		const f = fixture(t)
		await f.put(0, "beefcafe")
		const before = await f.client.createIndexByPayloadSlice(0, 4)
		await putLeafRecordInDB(f.storage, f.account, 0, {
			account: f.account,
			leafIndex: 0,
			payload: hexStringToUint8Array("beefcafe"),
			blockNumber: 42,
			previousInsertBlockNumber: 0,
			mergeLeftHashes: [],
		})
		assert.deepEqual(await f.client.createIndexByPayloadSlice(0, 4), before)
		assert.deepEqual(before, new Map([["beef", ["beefcafe"]]]))
	})

	test("groups matching prefixes and preserves payloads repeated at different leaf indices", async (t) => {
		const f = fixture(t)
		for (const [index, payload] of ["beefcafe", "beefdead", "cafebeef", "beefcafe"].entries())
			await f.put(index, payload)
		assert.deepEqual(
			await f.client.createIndexByPayloadSlice(0, 4),
			new Map([
				["beef", ["beefcafe", "beefdead", "beefcafe"]],
				["cafe", ["cafebeef"]],
			])
		)
	})

	test("offset and length continue to count hex characters, including odd positions", async (t) => {
		const f = fixture(t)
		await f.put(0, "beefcafe")
		for (const [offset, length, key] of [
			[0, 4, "beef"],
			[2, 4, "efca"],
			[1, 3, "eef"],
		] as const) {
			assert.deepEqual(await f.client.createIndexByPayloadSlice(offset, length), new Map([[key, ["beefcafe"]]]))
		}
	})

	test("short and empty payloads retain string-slice behavior", async (t) => {
		const f = fixture(t)
		for (const [index, payload] of ["", "be", "beef"].entries()) await f.put(index, payload)
		assert.deepEqual(
			await f.client.createIndexByPayloadSlice(0, 4),
			new Map([
				["", [""]],
				["be", ["be"]],
				["beef", ["beef"]],
			])
		)
		assert.deepEqual(await f.client.createIndexByPayloadSlice(8, 4), new Map([["", ["", "be", "beef"]]]))
	})

	test("an account with metadata but no payloads has an empty index", async (t) => {
		const f = fixture(t)
		await f.storage.put(`account:${f.account}:leaf:0:blockNumber`, "42")
		await f.storage.put(`account:${f.account}:leafIndex:0:rootCidAfterInsert`, "metadata")
		assert.deepEqual(await f.client.createIndexByPayloadSlice(0, 4), new Map())
	})
})
