import { CID } from "../ipfs/CID.js"
import { contractPeakHexToMmrCid } from "../utils/codec.js"
import { createLogger } from "../utils/logging.js"
import { callContractView, ethRpcFetch } from "./ethRpcFetch.js"
import { EthereumAddress } from "./EthereumAddress.js"
import {
	getEventTopic,
	getSelector,
	parseAccumulatorMetaBits,
	parseGetRootCIDResult,
	parseGetStateResult,
	parseLeafAppendedLog,
	parseNewAccountInitializedLog,
} from "./abiUtils.js"

import type { AccumulatorMetadata, PeakWithHeight } from "../mmr/types.js"
import type {
	NormalizedLeafAppendedEvent,
	NormalizedNewAccountInitializedEvent,
	RawEthLog,
} from "./events.types.js"
import type { Logger } from "../types/common.js"

import { LEAF_APPENDED_EVENT_SIGNATURE } from "../utils/constants.js"

const logger: Logger = createLogger("CommonCalls")
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

/**
 * Gets the SINGLETON_BIRTHDAY_BLOCK_NUM from the contract
 * @param ethereumHttpRpcUrl The Ethereum node RPC URL
 * @param contractAddress The deployed contract address
 * @returns Promise<number> The block number when the singleton was deployed
 */
export async function getSingletonBirthdayBlockNum(params: {
	ethereumHttpRpcUrl: string
	contractAddress: EthereumAddress
}): Promise<number> {
	const { ethereumHttpRpcUrl, contractAddress } = params
	const signature = "SINGLETON_BIRTHDAY_BLOCK_NUM()"
	const selector = getSelector(signature)
	const birthdayBlockHex = await callContractView(ethereumHttpRpcUrl, contractAddress.toString(), selector)
	// Convert hex string to number
	return parseInt(birthdayBlockHex, 16)
}

// Fetches the latest CID from the contract using a raw JSON-RPC call and ABI decoding.
// @param ethereumHttpRpcUrl - The Ethereum node RPC URL
// @param contractAddress - The deployed contract address
// @returns The latest CID as a multiformats.CID object
export async function getRootCID(params: {
	ethereumHttpRpcUrl: string
	contractAddress: EthereumAddress
	account: EthereumAddress
}): Promise<CID<unknown, 113, 18, 1>> {
	const { ethereumHttpRpcUrl, contractAddress, account } = params
	const signature = "getRootCID(address)"
	const selector = getSelector(signature)
	// Properly pad the address to 32 bytes (64 hex characters) as per Ethereum ABI spec
	const callData = selector + account.toString().slice(2).padStart(64, "0")
	const contractRootHex: string = await callContractView(ethereumHttpRpcUrl, contractAddress.toString(), callData)
	const contractRootBytes = parseGetRootCIDResult(contractRootHex)
	return CID.decode(Uint8Array.from(contractRootBytes))
}

export async function getState(params: {
	ethereumHttpRpcUrl: string
	contractAddress: EthereumAddress
	account: EthereumAddress
}): Promise<{ meta: AccumulatorMetadata; peaks: PeakWithHeight[] }> {
	try {
		const { ethereumHttpRpcUrl, contractAddress, account } = params
		const signature = "getState(address)"
		const selector = getSelector(signature)
		// Properly pad the address to 32 bytes (64 hex characters) as per Ethereum ABI spec
		const callData = selector + account.toString().slice(2).padStart(64, "0")
		const accumulatorDataHex: string = await callContractView(ethereumHttpRpcUrl, contractAddress.toString(), callData)

		const [mmrMetaBits, peaks] = parseGetStateResult(accumulatorDataHex)
		const meta = parseAccumulatorMetaBits(mmrMetaBits)
		const activePeaks: Uint8Array[] = peaks.slice(0, meta.peakCount) // only active peaks
		const activePeaksAsCids: CID<unknown, 113, 18, 1>[] = activePeaks.map(contractPeakHexToMmrCid)
		const activePeaksWithHeight: PeakWithHeight[] = activePeaksAsCids.map((cid, i) => ({
			cid,
			height: meta.peakHeights[i],
		}))
		return { meta, peaks: activePeaksWithHeight }
	} catch (err) {
		logger.error(`[getState] Error: ${err}`)
		throw err
	}
}

// --------------------- EVENTS --------------------
// Helper to format block numbers as 0x-prefixed hex strings
function toHexBlock(n: number): string {
	return "0x" + n.toString(16)
}

// Finds LeafAppended events using eth_getLogs.
// @param ethereumHttpRpcUrl string
// @param contractAddress string
// @param eventTopic string (keccak256 hash of event signature)
// @param fromBlock string (hex or "latest")
// @param toBlock string (hex or "latest")
// @returns Promise<NormalizedLeafAppendedtEvent[]> (array of log objects)
export async function getLeafAppendedLogs(params: {
	ethereumHttpRpcUrl: string
	contractAddress: EthereumAddress
	fromBlock: number
	toBlock: number
	specificAccounts?: EthereumAddress[]
}): Promise<NormalizedLeafAppendedEvent[]> {
	const { ethereumHttpRpcUrl, contractAddress, fromBlock, toBlock, specificAccounts } = params
	const eventTopic = getEventTopic(LEAF_APPENDED_EVENT_SIGNATURE)

	// Build the filter object with topics
	let filter: any = {
		address: contractAddress.toString(),
		fromBlock: toHexBlock(fromBlock),
		toBlock: toHexBlock(toBlock),
	}

	// For LeafAppended events, the account is an indexed parameter (the first one)
	// so we can use topics to filter directly at the RPC level
	if (specificAccounts && specificAccounts.length > 0) {
		// Format: [eventSignatureHash, accountAddressPadded]
		if (specificAccounts.length === 1) {
			// Single account - use exact match
			const paddedAddress = "0x" + specificAccounts[0].toString().slice(2).padStart(64, "0")
			filter.topics = [eventTopic, paddedAddress]
		} else {
			// Multiple accounts - use OR condition
			const paddedAddresses = specificAccounts.map((address) => "0x" + address.toString().slice(2).padStart(64, "0"))
			filter.topics = [eventTopic, paddedAddresses]
		}
	} else {
		// No account filtering
		filter.topics = [eventTopic]
	}

	const rawLogs: RawEthLog[] = await ethRpcFetch(ethereumHttpRpcUrl, "eth_getLogs", [filter])

	// Warn if topics[0] does not match eventTopic
	rawLogs.forEach((log, idx) => {
		const topic0 = log.topics ? log.topics[0].toLowerCase() : undefined
		const expected = eventTopic.toLowerCase()
		if (!log.topics || topic0 !== expected) {
			logger.warn(
				`[WARN:getLeafAppendedLogs] log[${idx}].topics[0] does not match eventTopic. topics[0]: ${topic0} | eventTopic: ${expected}`
			)
		}
	})

	// Parse the logs
	const parsedLogs: NormalizedLeafAppendedEvent[] = await Promise.all(
		rawLogs
			.filter((log) => log.topics && log.topics[0] && log.topics[0].toLowerCase() === eventTopic.toLowerCase())
			.map(async (log) => {
				return await parseLeafAppendedLog(log)
			})
	)

	return parsedLogs
}

/**
 * Finds NewAccountInitialized events using eth_getLogs.
 * @param ethereumHttpRpcUrl string
 * @param contractAddress EthereumAddress
 * @param fromBlock number (block number to start searching from)
 * @param toBlock number (block number to end searching at)
 * @param eventTopicOverride string (optional, keccak256 hash of event signature)
 * @returns Promise<NormalizedNewAccountInitializedEvent[]> (array of normalized event objects)
 */
export async function getNewAccountInitializedLogs(params: {
	ethereumHttpRpcUrl: string
	contractAddress: EthereumAddress
	fromBlock: number
	toBlock: number
}): Promise<NormalizedNewAccountInitializedEvent[]> {
	const { ethereumHttpRpcUrl, contractAddress, fromBlock, toBlock } = params
	const eventTopic = getEventTopic("NewAccountInitialized(address)")
	const rawLogs: RawEthLog[] = await ethRpcFetch(ethereumHttpRpcUrl, "eth_getLogs", [
		{
			address: contractAddress.toString(),
			topics: [eventTopic],
			fromBlock: toHexBlock(fromBlock),
			toBlock: toHexBlock(toBlock),
		},
	])

	// Warn if topics[0] does not match eventTopic
	rawLogs.forEach((log, idx) => {
		const topic0 = log.topics ? log.topics[0].toLowerCase() : undefined
		const expected = eventTopic.toLowerCase()
		if (!log.topics || topic0 !== expected) {
			logger.warn(
				`[WARN:getNewAccountInitializedLogs] log[${idx}].topics[0] does not match eventTopic. topics[0]: ${topic0} | eventTopic: ${expected}`
			)
		}
	})

	// Parse the logs - no need to filter by account as we did it at the RPC level
	const parsedLogs: NormalizedNewAccountInitializedEvent[] = rawLogs
		.filter((log) => log.topics && log.topics[0] && log.topics[0].toLowerCase() === eventTopic.toLowerCase())
		.map((log) => parseNewAccountInitializedLog(log))

	return parsedLogs
}
