import assert from "node:assert/strict"
import { test } from "node:test"
import { getBytes, hexlify, Interface, toBeHex } from "ethers"
import { parseLeafAppendedLog } from "../source/ethereum/abiUtils.js"
import type { RawEthLog } from "../source/ethereum/events.types.js"

const abi = new Interface([
	"event LeafAppended(address indexed account, uint256 leafIndex, uint256 previousInsertBlockNumber, bytes payload, bytes32[] mergeLeftHashes)",
])
const account = "0x" + "ab".repeat(20)

function encodeLog(payload: string, hashes: string[]): RawEthLog {
	return {
		...abi.encodeEventLog(abi.getEvent("LeafAppended")!, [account, 2 ** hashes.length - 1, 12, payload, hashes]),
		address: "0x" + "11".repeat(20),
		blockNumber: "0x10",
		blockHash: "0x" + "CD".repeat(32),
	}
}

function replaceWord(log: RawEthLog, byteOffset: number, value: bigint): RawEthLog {
	const start = 2 + byteOffset * 2
	return { ...log, data: log.data.slice(0, start) + toBeHex(value, 32).slice(2) + log.data.slice(start + 64) }
}

test("LeafAppended decoding preserves ABI payloads and merge hashes through the contract limit", async () => {
	for (const count of [0, 1, 31]) {
		const payload = count === 0 ? "0x" : "0x" + "abcd".repeat(17)
		const hashes = Array.from({ length: count }, (_, i) => toBeHex(i + 1, 32))
		const event = await parseLeafAppendedLog(encodeLog(payload, hashes))
		assert.equal(event.account.toString(), account)
		assert.equal(event.leafIndex, 2 ** count - 1)
		assert.equal(event.previousInsertBlockNumber, 12)
		assert.equal(event.blockNumber, 16)
		assert.equal(event.blockHash, "0x" + "cd".repeat(32))
		assert.deepEqual(event.payload, getBytes(payload))
		assert.deepEqual(event.mergeLeftHashes.map((cid) => hexlify(cid.multihash.digest)), hashes)
		for (const cid of event.mergeLeftHashes) {
			assert.equal(cid.version, 1)
			assert.equal(cid.code, 0x71)
			assert.equal(cid.multihash.code, 0x12)
		}
	}
})

test("LeafAppended decoding bounds untrusted ABI offsets and lengths before decoding", async () => {
	const empty = encodeLog("0x", [])
	const cases: [string, RawEthLog][] = [
		["missing head", { ...empty, data: empty.data.slice(0, 2 + 127 * 2) }],
		["invalid hex", { ...empty, data: empty.data.slice(0, -2) + "gg" }],
		["offset inside head", replaceWord(empty, 64, 64n)],
		["unaligned offset", replaceWord(empty, 64, 129n)],
		["uint256 offset", replaceWord(empty, 64, (1n << 200n) + 128n)],
		["uint256 payload length", replaceWord(empty, 128, 1n << 200n)],
		["missing merge hashes", replaceWord(empty, 160, 1n)],
		["amplified merge count", replaceWord(empty, 160, 20_000n)],
		["uint256 merge count", replaceWord(empty, 160, 1n << 200n)],
		["beyond contract limit", encodeLog("0x", Array(32).fill(toBeHex(1, 32)))],
	]
	for (const [reason, log] of cases) {
		await assert.rejects(parseLeafAppendedLog(log), /Invalid LeafAppended/, reason)
	}
})
