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
	const contract = new AccumulatorContract(defaultLightClientAccumulatorContractConfig)
	const events = new EventCacheService(storage, contract, defaultLightClientEventCacheServiceConfig)
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	const client = new DataClient(account, {
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

describe("payload ranges containing empty payloads", () => {
	test("a single empty payload is returned consistently by individual and range reads", async (t) => {
		const { client } = await fixture(t, [""])
		assert.equal(await client.getPayload(0), "")
		assert.deepEqual(await client.getPayloadInRange(0, 0), [{ index: 0, payload: "" }])
	})

	test("mixed ranges retain empty payloads at the start, middle, and end", async (t) => {
		const payloads = ["", "00", "", "beef", ""]
		const { client } = await fixture(t, payloads)
		const expected = payloads.map((payload, index) => ({ index, payload }))
		assert.deepEqual(await client.getPayloadInRange(0, 4), expected)
		assert.deepEqual(await client.getPayloadInRange(1, 3), expected.slice(1, 4))
		assert.deepEqual(await client.getPayloadInRange(2, 99), expected.slice(2))
	})

	test("a range of empty payloads keeps its leaf indices and respects the available boundary", async (t) => {
		const { client } = await fixture(t, ["", "", ""])
		assert.deepEqual(await client.getPayloadInRange(1, 99), [
			{ index: 1, payload: "" },
			{ index: 2, payload: "" },
		])
		assert.deepEqual(await client.getPayloadInRange(3, 99), [])
	})

	test("a missing leaf record still raises an error instead of becoming an empty payload", async (t) => {
		const { client, storage, account } = await fixture(t, [""])
		await storage.delete(`account:${account}:leaf:0:account`)
		assert.equal(await client.getPayload(0), undefined)
		await assert.rejects(client.getPayloadInRange(0, 0), /No payload found for leaf index 0/)
	})
})
