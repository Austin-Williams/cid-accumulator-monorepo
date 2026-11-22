import { contractPeakHexToMmrCid } from "../utils/codec.js"
import { createLogger } from "../utils/logging.js"
import { isPlainObject } from "../utils/objects.js"
import { callContractView, ethRpcFetch } from "./ethRpcFetch.js"
import { EthereumAddress } from "./EthereumAddress.js"
import {
	getEventTopic,
	getSelector,
	parseAccumulatorMetaBits,
	parseGetStateResult,
	parseDataAppendedLog,
} from "./abiUtils.js"

import type { AccumulatorMetadata, PeakWithHeight } from "../mmr/types.js"
import type {
	BlockReference,
	ChainBlock,
	NormalizedDataAppendedEvent,
	RawEthLog,
} from "./events.types.js"
import type { Logger } from "../types/common.js"

import { DATA_APPENDED_EVENT_SIGNATURE } from "../utils/constants.js"

const logger: Logger = createLogger("CommonCalls")

/** Return the network identity without narrowing its JSON-RPC quantity to a Number. */
export async function getChainId(ethereumHttpRpcUrl: string): Promise<bigint> {
	const value: unknown = await ethRpcFetch(ethereumHttpRpcUrl, "eth_chainId", [])
	if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) {
		throw new Error("Ethereum RPC returned an invalid chain ID")
	}
	return BigInt(value)
}

function normalizeBlockHash(hash: unknown): string {
	if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Invalid Ethereum block hash")
	return hash.toLowerCase()
}

function parseChainBlock(value: unknown): ChainBlock {
	if (!isPlainObject(value) || typeof value.number !== "string" || !/^0x[0-9a-fA-F]+$/.test(value.number)) {
		throw new Error("Ethereum RPC returned a missing or invalid block")
	}
	const number = Number(value.number)
	if (!Number.isSafeInteger(number) || number < 0) throw new Error("Ethereum block number is outside the safe integer range")
	return { number, hash: normalizeBlockHash(value.hash), parentHash: normalizeBlockHash(value.parentHash) }
}

/** Fetch a header without transactions, preserving the identity needed to detect reorganizations. */
export async function getBlock(
	ethereumHttpRpcUrl: string,
	block: number | "latest" | "finalized"
): Promise<ChainBlock> {
	if (typeof block === "number" && (!Number.isSafeInteger(block) || block < 0)) throw new Error("Invalid block number")
	const reference = typeof block === "number" ? toHexBlock(block) : block
	const result = parseChainBlock(await ethRpcFetch(ethereumHttpRpcUrl, "eth_getBlockByNumber", [reference, false]))
	if (typeof block === "number" && result.number !== block) throw new Error("Ethereum RPC returned the wrong block number")
	return result
}

/** Retrieve a parent from a branch even if it is no longer canonical. */
export async function getBlockByHash(ethereumHttpRpcUrl: string, hash: string): Promise<ChainBlock> {
	const expectedHash = normalizeBlockHash(hash)
	const result = parseChainBlock(await ethRpcFetch(ethereumHttpRpcUrl, "eth_getBlockByHash", [expectedHash, false]))
	if (result.hash !== expectedHash) throw new Error("Ethereum RPC returned the wrong block hash")
	return result
}

/** Read up to one BLOCKHASH window, newest parent first, in one simulated creation call. */
export async function getAncestorHashes(url: string, head: Pick<ChainBlock, "number" | "hash">, count: number): Promise<string[]> {
	if (!Number.isSafeInteger(head.number) || head.number < 0) throw new Error("Invalid block height")
	if (!Number.isInteger(count) || count < 1 || count > Math.min(head.number, 256)) throw new Error("Invalid ancestor count")
	const size = (count + 1) * 32
	const data = "0x" + [
		"43600052",              // mstore(0, number()) also gives the returned code a safe leading byte.
		"6020",                  // offset = 32
		"5b",                    // loop (byte 6)
		"8060051c4303408152",    // mstore(offset, blockhash(number() - (offset >> 5)))
		"602001",                // offset += 32
		"61" + size.toString(16).padStart(4, "0") + "8110600657", // jump to loop while offset < size
		"6000f3",                // return(0, offset)
	].join("")
	const result = await ethRpcFetch(url, "eth_call", [{ data }, { blockHash: normalizeBlockHash(head.hash), requireCanonical: true }])
	if (typeof result !== "string" || result.length !== 2 + size * 2 || !/^0x[\da-f]+$/i.test(result) ||
		BigInt("0x" + result.slice(2, 66)) !== BigInt(head.number)) throw new Error("RPC returned invalid ancestor data")
	const hashes = result.slice(66).match(/.{64}/g)!.map(word => "0x" + word.toLowerCase())
	if (hashes.some(hash => /^0x0+$/.test(hash))) throw new Error("RPC returned an unavailable ancestor hash")
	return hashes
}

function logBlockFilter(fromBlock: number, toBlock: number, blockHash?: string): object {
	if (blockHash === undefined) return { fromBlock: toHexBlock(fromBlock), toBlock: toHexBlock(toBlock) }
	if (fromBlock !== toBlock) throw new Error("A block hash log query must identify a single block")
	return { blockHash: normalizeBlockHash(blockHash) }
}

function verifyLogBlocks(logs: unknown, blockNumber: number, blockHash?: string): asserts logs is RawEthLog[] {
	if (!Array.isArray(logs)) throw new Error("Ethereum RPC returned an invalid log list")
	const expectedHash = blockHash === undefined ? undefined : normalizeBlockHash(blockHash)
	for (const log of logs) {
		if (
			!isPlainObject(log) || typeof log.address !== "string" || typeof log.data !== "string" ||
			!Array.isArray(log.topics) || !log.topics.every(topic => typeof topic === "string") ||
			(typeof log.blockNumber !== "number" && typeof log.blockNumber !== "string") ||
			(log.blockHash !== undefined && typeof log.blockHash !== "string")
		) throw new Error("Ethereum RPC returned an invalid log")
		if (expectedHash !== undefined && (log.blockHash?.toLowerCase() !== expectedHash || Number(log.blockNumber) !== blockNumber)) {
			throw new Error("Ethereum RPC returned logs from a different block")
		}
	}
}

/**
 * Gets the current block number from an Ethereum node
 * @param ethereumHttpRpcUrl The Ethereum node RPC URL
 * @returns Promise<number> The current block number
 */
export async function getBlockNumber(ethereumHttpRpcUrl: string): Promise<number> {
	try {
		const blockNumberHex = await ethRpcFetch(ethereumHttpRpcUrl, "eth_blockNumber", [])

		if (blockNumberHex === undefined) {
			logger.error("Received undefined blockNumberHex from ethRpcFetch")
			throw new Error("Failed to get block number: received undefined")
		}

		if (typeof blockNumberHex !== "string" || !/^0x[0-9a-fA-F]+$/.test(blockNumberHex)) {
			logger.error(`Invalid blockNumberHex from ethRpcFetch: ${blockNumberHex}`)
			throw new Error(`Invalid block number response: ${blockNumberHex}`)
		}

		return parseInt(blockNumberHex, 16)
	} catch (error) {
		logger.error(`Error getting block number: ${error}`)
		throw error
	}
}

/** Fetch this accumulator's state, including its first-append birthday. */
export async function getCIDAccumulatorState(params: {
	ethereumHttpRpcUrl: string
	contractAddress: EthereumAddress
	block?: BlockReference
}): Promise<{ meta: AccumulatorMetadata; peaks: PeakWithHeight[] }> {
	const { ethereumHttpRpcUrl, contractAddress, block = "latest" } = params
	const result: string = await callContractView(
		ethereumHttpRpcUrl, contractAddress.toString(), getSelector("getCIDAccumulatorState()"), block
	)
	// A rollback may precede deployment of the application. An empty return by itself
	// is not proof of that: verify code at exactly the same historical block.
	if (result === "0x" && block !== "latest" && block !== "pending") {
		const code = await ethRpcFetch(ethereumHttpRpcUrl, "eth_getCode", [contractAddress.toString(), block])
		if (code === "0x") return { meta: parseAccumulatorMetaBits(0n), peaks: [] }
	}
	const [merkleMountainRangeMetaBits, peaks] = parseGetStateResult(result)
	const meta = parseAccumulatorMetaBits(merkleMountainRangeMetaBits)
	return {
		meta,
		peaks: peaks.slice(0, meta.peakCount).map((peak, i) => ({
			cid: contractPeakHexToMmrCid(peak),
			height: meta.peakHeights[i],
		})),
	}
}

function toHexBlock(n: number): string {
	return "0x" + n.toString(16)
}

/** Find this accumulator's append events by emitting address and event signature. */
export async function getDataAppendedLogs(params: {
	ethereumHttpRpcUrl: string
	contractAddress: EthereumAddress
	fromBlock: number
	toBlock: number
	blockHash?: string
}): Promise<NormalizedDataAppendedEvent[]> {
	const { ethereumHttpRpcUrl, contractAddress, fromBlock, toBlock, blockHash } = params
	const eventTopic = getEventTopic(DATA_APPENDED_EVENT_SIGNATURE)
	const filter = {
		address: contractAddress.toString(),
		topics: [eventTopic],
		...logBlockFilter(fromBlock, toBlock, blockHash),
	}
	const logs = await ethRpcFetch(ethereumHttpRpcUrl, "eth_getLogs", [filter])
	verifyLogBlocks(logs, fromBlock, blockHash)
	for (const log of logs) {
		if (log.address.toLowerCase() !== contractAddress.toString()) {
			throw new Error("Ethereum RPC returned logs from a different accumulator")
		}
		const number = Number(log.blockNumber)
		if (!Number.isSafeInteger(number) || number < fromBlock || number > toBlock) {
			throw new Error("Ethereum RPC returned logs outside the requested block range")
		}
	}
	return Promise.all(logs.map(parseDataAppendedLog))
}
