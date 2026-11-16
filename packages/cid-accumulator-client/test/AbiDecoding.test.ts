import assert from "node:assert/strict"
import { test } from "node:test"
import { concat, getBytes, hexlify, Interface, toBeHex } from "ethers"
import { parseLeafAppendedLog } from "../source/ethereum/abiUtils.js"
import type { RawEthLog } from "../source/ethereum/events.types.js"

const abi = new Interface([
	"event LeafAppended(address indexed account, uint64 metadata, bytes payloadAndMergeHashes)",
])
const account = "0x" + "ab".repeat(20)
const previousInsertBlockNumber = 20_000_000

function encodeLog(payload: string, hashes: string[]): RawEthLog {
	const metadata = BigInt(2 ** hashes.length - 1) | (BigInt(previousInsertBlockNumber) << 32n)
	return {
		...abi.encodeEventLog(abi.getEvent("LeafAppended")!, [account, metadata, concat([payload, ...hashes])]),
		address: "0x" + "11".repeat(20),
		blockNumber: toBeHex(previousInsertBlockNumber + 1),
		blockHash: "0x" + "CD".repeat(32),
	}
}

function replaceWord(log: RawEthLog, byteOffset: number, value: bigint): RawEthLog {
	const start = 2 + byteOffset * 2
	return { ...log, data: log.data.slice(0, start) + toBeHex(value, 32).slice(2) + log.data.slice(start + 64) }
}

test("LeafAppended decoding preserves ABI payloads and merge hashes through the contract limit", async () => {
	for (const count of [0, 1, 2, 31]) {
		const hashes = Array.from({ length: count }, (_, i) => toBeHex(i + 1, 32))
		for (const size of [0, 1, 31, 32, 33]) {
			const payload = "0x" + "ab".repeat(size)
			const event = await parseLeafAppendedLog(encodeLog(payload, hashes))
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

test("LeafAppended decoding bounds untrusted ABI offsets and lengths before decoding", async () => {
	const empty = encodeLog("0x", [])
	const unalignedPayload = encodeLog("0xab", [])
	const cases: [string, RawEthLog][] = [
		["missing head", { ...empty, data: empty.data.slice(0, 2 + 63 * 2) }],
		["invalid hex", { ...empty, data: empty.data.slice(0, -2) + "gg" }],
		["metadata exceeds uint64", replaceWord(empty, 0, 1n << 64n)],
		["offset inside head", replaceWord(empty, 32, 32n)],
		["unaligned offset", replaceWord(empty, 32, 65n)],
		["uint256 offset", replaceWord(empty, 32, (1n << 200n) + 64n)],
		["uint256 combined length", replaceWord(empty, 64, 1n << 200n)],
		["missing merge hashes", replaceWord(empty, 0, 1n)],
		["missing padding", { ...unalignedPayload, data: unalignedPayload.data.slice(0, -2) }],
		["beyond contract limit", encodeLog("0x", Array(32).fill(toBeHex(1, 32)))],
	]
	for (const [reason, log] of cases) {
		await assert.rejects(parseLeafAppendedLog(log), /Invalid LeafAppended/, reason)
	}
})
