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
import { hexStringToUint8Array } from "../source/utils/codec.js"

async function fixture(t: TestContext, payloads: string[]) {
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
	for (const [leafIndex, payload] of payloads.entries()) {
		await putLeafRecordInDB(storage, account, leafIndex, {
			account,
			leafIndex,
			payload: hexStringToUint8Array(payload),
		})
	}
	return { client, storage, account }
}

describe("32-byte payload ranges", () => {
	test("zero-valued payloads retain all bytes in individual and range reads", async (t) => {
		const zero = "00".repeat(32)
		const { client } = await fixture(t, [zero])
		assert.equal(await client.getPayload(0), zero)
		assert.deepEqual(await client.getPayloadInRange(0, 0), [{ index: 0, payload: zero }])
	})

	test("ranges preserve payload order and clip to the highest available index", async (t) => {
		const payloads = [0, 1, 255, 0, 2].map(value => value.toString(16).padStart(2, "0").repeat(32))
		const { client } = await fixture(t, payloads)
		const expected = payloads.map((payload, index) => ({ index, payload }))
		assert.deepEqual(await client.getPayloadInRange(0, 4), expected)
		assert.deepEqual(await client.getPayloadInRange(1, 3), expected.slice(1, 4))
		assert.deepEqual(await client.getPayloadInRange(2, 99), expected.slice(2))
		assert.deepEqual(await client.getPayloadInRange(5, 99), [])
	})

	test("a missing leaf record is not returned as a zero-valued payload", async (t) => {
		const { client, storage, account } = await fixture(t, ["00".repeat(32)])
		await storage.delete(`account:${account}:leaf:0:account`)
		assert.equal(await client.getPayload(0), undefined)
		await assert.rejects(client.getPayloadInRange(0, 0), /No payload found for leaf index 0/)
	})
})
