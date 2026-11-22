import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { defaultLightClientAccumulatorContractConfig } from "../source/config/defaultConfig.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { getAncestorHashes } from "../source/ethereum/commonCalls.js"
import { ChainChangedError, getChainState } from "../source/services/ChainState.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { blockHeader, initializeChain, mockChain } from "./mockChain.js"

async function fixture(t: TestContext, height: number) {
	const contract = new AccumulatorContract({
		...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: "0x" + "11".repeat(20),
	})
	const storage = new InMemoryAdapter()
	await initializeChain(storage)
	mockChain(t, contract)
	t.mock.method(contract, "getBlockNumber", async () => height)
	return { storage, contract, chain: await getChainState(storage, contract) }
}

test("long ancestry walks pin each 256-parent window to the last hash of the preceding window", async t => {
	const { storage, contract, chain } = await fixture(t, 520)
	const batches = t.mock.method(contract, "getAncestorHashes")
	const parents = t.mock.method(contract, "getBlockByHash")
	assert.deepEqual((await chain.snapshot()).block, blockHeader(520))
	assert.deepEqual(batches.mock.calls.map(call => call.arguments), [ [520, 256], [264, 256], [8, 8] ].map(([number, count]) =>
		[{ number, hash: blockHeader(number).hash }, count]))
	assert.equal(parents.mock.callCount(), 0)
	for (const n of [1, 8, 9, 264, 265, 519, 520]) assert.deepEqual(JSON.parse((await storage.get("chain:block:" + n))!), blockHeader(n))
})

test("a bad ancestor batch leaves the saved canonical head intact", async t => {
	const { storage, contract, chain } = await fixture(t, 64)
	t.mock.method(contract, "getAncestorHashes", async () => Array.from({ length: 64 }, (_, i) => blockHeader(i).hash))
	await assert.rejects(chain.snapshot(), ChainChangedError)
	assert.deepEqual(JSON.parse((await storage.get("chain:head"))!), blockHeader(0))
	assert.equal(await storage.get("chain:block:64"), undefined)
})

test("providers that reject simulated creation calls can still supply the pinned branch by hash", async t => {
	const { contract, chain } = await fixture(t, 4)
	t.mock.method(contract, "getAncestorHashes", async () => { throw new Error("creation disabled") })
	const headers = t.mock.method(contract, "getBlockByHash")
	await chain.snapshot()
	assert.deepEqual(headers.mock.calls.map(call => call.arguments[0]), [4, 3, 2, 1].map(n => blockHeader(n).hash))
})

test("the ancestor reader pins one creation call, checks the execution height and rejects unavailable hashes", async t => {
	const head = blockHeader(300)
	const parents = [blockHeader(299).hash, blockHeader(298).hash]
	let height = head.number
	const fetch = t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		const { method, params } = JSON.parse(String(init.body))
		assert.equal(method, "eth_call")
		assert.deepEqual(Object.keys(params[0]), ["data"])
		assert.deepEqual(params[1], { blockHash: head.hash, requireCanonical: true })
		const result = "0x" + height.toString(16).padStart(64, "0") + parents.map(h => h.slice(2)).join("")
		return Response.json({ result })
	})
	assert.deepEqual(await getAncestorHashes("https://rpc.example.test", head, 2), parents)
	assert.equal(fetch.mock.callCount(), 1)
	height--
	await assert.rejects(getAncestorHashes("https://rpc.example.test", head, 2), /invalid ancestor/)
	height++
	parents[1] = "0x" + "0".repeat(64)
	await assert.rejects(getAncestorHashes("https://rpc.example.test", head, 2), /unavailable/)
	await assert.rejects(getAncestorHashes("https://rpc.example.test", head, 257), /Invalid ancestor count/)
})
