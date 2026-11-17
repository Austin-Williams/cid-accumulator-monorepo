import assert from "node:assert/strict"
import { test } from "node:test"
import { concat, getBytes, hexlify, Interface, toBeHex } from "ethers"
import { parseDataAppendedLog } from "../source/ethereum/abiUtils.js"
import { getDataAppendedLogs, getCIDAccumulatorState } from "../source/ethereum/commonCalls.js"
import { getRootCIDFromPeaks } from "../source/mmr/utils.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { CIDAccumulatorABI } from "../source/utils/constants.js"
import type { RawEthLog } from "../source/ethereum/events.types.js"

const abi = new Interface(CIDAccumulatorABI)
const account = "0x" + "ab".repeat(20)
const previousInsertBlockNumber = 20_000_000

function encodeLog(payload: string, hashes: string[]): RawEthLog {
	const metadata = BigInt(2 ** hashes.length - 1) | (BigInt(previousInsertBlockNumber) << 32n)
	return {
		...abi.encodeEventLog(abi.getEvent("DataAppendedToCIDAccumulator")!, [metadata, payload, concat(hashes)]),
		address: account,
		blockNumber: toBeHex(previousInsertBlockNumber + 1),
		blockHash: "0x" + "CD".repeat(32),
	}
}

function replaceWord(log: RawEthLog, byteOffset: number, value: bigint): RawEthLog {
	const start = 2 + byteOffset * 2
	return { ...log, data: log.data.slice(0, start) + toBeHex(value, 32).slice(2) + log.data.slice(start + 64) }
}

test("DataAppendedToCIDAccumulator decoding preserves ABI payloads and merge hashes through the contract limit", async () => {
	for (const count of [0, 1, 2, 31]) {
		const hashes = Array.from({ length: count }, (_, i) => toBeHex(i + 1, 32))
		for (const payload of [
			"0x" + "00".repeat(32),
			"0x" + "ff".repeat(32),
			"0x00" + "ab".repeat(30) + "00",
			toBeHex(1, 32),
		]) {
			const event = await parseDataAppendedLog(encodeLog(payload, hashes))
			assert.equal(event.account.toString(), account)
			assert.equal(event.leafIndex, 2 ** count - 1)
			assert.equal(event.previousInsertBlockNumber, previousInsertBlockNumber)
			assert.equal(event.blockNumber, previousInsertBlockNumber + 1)
			assert.equal(event.blockHash, "0x" + "cd".repeat(32))
			assert.deepEqual(event.payload, getBytes(payload))
			assert.deepEqual(event.mergeLeftHashes.map((cid) => hexlify(cid.multihash.digest)), hashes)
			for (const cid of event.mergeLeftHashes) {
				assert.equal(cid.version, 1)
				assert.equal(cid.code, 0x71)
				assert.equal(cid.multihash.code, 0x1b)
			}
		}
	}
})

test("DataAppendedToCIDAccumulator decoding bounds untrusted ABI offsets and lengths before decoding", async () => {
	const empty = encodeLog(toBeHex(0, 32), [])
	const cases: [string, RawEthLog][] = [
		["missing head", { ...empty, data: empty.data.slice(0, 2 + 95 * 2) }],
		["invalid hex", { ...empty, data: empty.data.slice(0, -2) + "gg" }],
		["metadata exceeds uint64", replaceWord(empty, 0, 1n << 64n)],
		["offset inside head", replaceWord(empty, 64, 64n)],
		["unaligned offset", replaceWord(empty, 64, 97n)],
		["uint256 offset", replaceWord(empty, 64, (1n << 200n) + 96n)],
		["uint256 merge hashes length", replaceWord(empty, 96, 1n << 200n)],
		["missing merge hashes", replaceWord(empty, 0, 1n)],
		["truncated body", { ...empty, data: empty.data.slice(0, -2) }],
		["beyond contract limit", encodeLog(toBeHex(0, 32), Array(32).fill(toBeHex(1, 32)))],
	]
	for (const [reason, log] of cases) {
		await assert.rejects(parseDataAppendedLog(log), /Invalid DataAppendedToCIDAccumulator/, reason)
	}
})


test("accumulator RPC calls use the consumer address and pinned block without account arguments", async (t) => {
	const contractAddress = new EthereumAddress(account)
	const blockHash = "0x" + "cd".repeat(32)
	const block = { blockHash, requireCanonical: true as const }
	const payload = toBeHex(1, 32)
	const log = encodeLog(payload, [])
	const metadata = 1n << 160n | 1n << 165n | BigInt(previousInsertBlockNumber) << 197n | 100n << 229n
	const peak = "0x" + "42".repeat(32)
	const root = "0x01711b20" + peak.slice(2)
	const requests: Array<{ method: string; params: any[] }> = []
	t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
		const request = JSON.parse(options.body as string)
		requests.push(request)
		let result: unknown
		if (request.method === "eth_chainId") result = "0x20000000000001"
		else if (request.method === "eth_getLogs") result = [log]
		else if (request.params[0].data === abi.getFunction("getCIDAccumulatorState")!.selector) {
			result = abi.encodeFunctionResult("getCIDAccumulatorState", [metadata, [peak, ...Array(31).fill(toBeHex(0, 32))]])
		}
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }))
	})
	const params = { ethereumHttpRpcUrl: "http://localhost:8545", contractAddress, block }
	const contract = new AccumulatorContract({
		ethereumHttpRpcUrl: params.ethereumHttpRpcUrl,
		accumulatorContractAddress: contractAddress,
		rateLimiterOptions: { intervalMs: 0, maxRetries: 0, baseDelay: 0, capDelay: 0 },
	})
	assert.equal(requests.length, 0)
	assert.equal(await contract.getChainId(), 0x20000000000001n)
	assert.equal(contract.address.toString(), account)
	const state = await getCIDAccumulatorState(params)
	assert.equal(state.meta.leafCount, 1)
	assert.equal(state.meta.deployBlockNumber, 100)
	assert.equal(hexlify((await getRootCIDFromPeaks(state.peaks.map((entry) => entry.cid))).bytes), root)
	const events = await getDataAppendedLogs({
		...params,
		fromBlock: previousInsertBlockNumber + 1,
		toBlock: previousInsertBlockNumber + 1,
		blockHash,
	})
	assert.equal(events[0].account.toString(), account)
	assert.deepEqual(events[0].payload, getBytes(payload))
	assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
		{ method: "eth_chainId", params: [] },
		{ method: "eth_call", params: [{ to: account, data: abi.getFunction("getCIDAccumulatorState")!.selector }, block] },
		{ method: "eth_getLogs", params: [{ address: account, topics: [abi.getEvent("DataAppendedToCIDAccumulator")!.topicHash], blockHash }] },
	])
})

test("historical state before deployment is empty only after checking code at that block", async (t) => {
	const block = { blockHash: "0x" + "12".repeat(32), requireCanonical: true as const }
	const requests: Array<{ method: string; params: unknown[] }> = []
	t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
		const request = JSON.parse(options.body as string)
		requests.push(request)
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "0x" }))
	})
	const state = await getCIDAccumulatorState({
		ethereumHttpRpcUrl: "http://localhost:8545",
		contractAddress: new EthereumAddress(account),
		block,
	})
	assert.equal(state.meta.leafCount, 0)
	assert.equal(state.meta.deployBlockNumber, 0)
	assert.deepEqual(state.peaks, [])
	assert.deepEqual(requests.map(({ method, params }) => ({ method, params })), [
		{ method: "eth_call", params: [{ to: account, data: abi.getFunction("getCIDAccumulatorState")!.selector }, block] },
		{ method: "eth_getCode", params: [account, block] },
	])
})
