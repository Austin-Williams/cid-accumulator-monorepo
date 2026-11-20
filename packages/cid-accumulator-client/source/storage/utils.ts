import { CID } from "../ipfs/CID.js"
import type { LeafRecord } from "../mmr/types.js"
import type { Storage } from "./interface.js"
import { EthereumAddress } from "../ethereum/EthereumAddress.js"
import {
	cidDataPairArrayToStringForDB,
	uint8ArrayToHexString,
	hexStringToUint8Array,
	stringToPeakWithHeightArray,
	peakWithHeightArrayToStringForDB,
	stringToCidDataPairArray,
} from "../utils/codec.js"

// ====================================================
// DATABASE OPERATIONS & DATA MANAGEMENT
// Functions for storing, retrieving, and managing
// accumulator data in the configured storage backend.
// ====================================================

/** Remove a rolled-back suffix, including fields that a replacement append may omit. */
export async function deleteLeafSuffix(storage: Storage, account: EthereumAddress, from: number, to: number): Promise<void> {
	const fields = ["account", "leafIndex", "payload", "payloadCID", "blockNumber", "blockHash", "mergeLeftHashes", "previousInsertBlockNumber", "rootCidAfterInsert", "insertionTrail", "peaksWithHeightsAfterInsert"]
	for (let i = from; i < to; i++) {
		const prefix = `account:${account}:leaf:${i}`
		for (const field of fields) await storage.delete(`${prefix}:${field}`)
		await storage.delete(prefix)
		await storage.delete(`account:${account}:leafIndex:${i}:rootCidAfterInsert`)
		await storage.delete(`account:${account}:leafIndex:${i}:peaksWithHeightsAfterInsert`)
	}
}

// Store a leaf record in the DB by leafIndex, splitting fields into separate keys.
export async function putLeafRecordInDB(
	storage: Storage,
	account: EthereumAddress,
	leafIndex: number,
	value: LeafRecord
): Promise<void> {
	const keyPrefix = `account:${account.toString()}:leaf:${leafIndex}`

	// Store required fields
	await storage.put(`${keyPrefix}:account`, value.account.toString())
	await storage.put(`${keyPrefix}:leafIndex`, value.leafIndex.toString())
	await storage.put(`${keyPrefix}:payload`, uint8ArrayToHexString(value.payload))

	async function putField<K extends keyof LeafRecord>(key: K, format: (field: NonNullable<LeafRecord[K]>) => string) {
		const field = value[key]
		if (field !== undefined) await storage.put(`${keyPrefix}:${key}`, format(field))
	}
	await Promise.all([
		putField("payloadCID", String),
		putField("blockNumber", String),
		putField("mergeLeftHashes", (cids) => JSON.stringify(cids.map(String))),
		putField("previousInsertBlockNumber", String),
		putField("rootCidAfterInsert", String),
		putField("insertionTrail", cidDataPairArrayToStringForDB),
		putField("peaksWithHeightsAfterInsert", peakWithHeightArrayToStringForDB),
	])
}

/** Reads a leaf payload after checking the required fields of its record. */
export async function getLeafPayloadFromDB(
	storage: Storage,
	account: EthereumAddress,
	leafIndex: number
): Promise<Uint8Array | undefined> {
	const keyPrefix = `account:${account.toString()}:leaf:${leafIndex}`

	// Get account field (should match the account parameter)
	const storedAccountStr = await storage.get(`${keyPrefix}:account`)
	if (storedAccountStr === undefined) return undefined
	if (storedAccountStr !== account.toString()) throw new Error("Account mismatch! This should never happen.")

	// Get required leafIndex field
	const leafIndexStr = await storage.get(`${keyPrefix}:leafIndex`)
	if (leafIndexStr === undefined)
		throw new Error("LeafIndex not found, but account and leafIndex exist! This should never happen.")
	if (leafIndexStr !== leafIndex.toString()) throw new Error("LeafIndex mismatch! This should never happen.")

	// Get required payload field
	const payloadStr = await storage.get(`${keyPrefix}:payload`)
	if (payloadStr === undefined)
		throw new Error("Payload not found, but account and leafIndex exist! This should never happen.")
	return hexStringToUint8Array(payloadStr)
}

export async function getLeafRecordFromDB(
	storage: Storage,
	account: EthereumAddress,
	leafIndex: number
): Promise<LeafRecord | undefined> {
	const payload = await getLeafPayloadFromDB(storage, account, leafIndex)
	if (payload === undefined) return undefined
	const keyPrefix = `account:${account}:leaf:${leafIndex}`

	const result: LeafRecord = { account, leafIndex, payload }
	async function readField<K extends keyof LeafRecord>(key: K, parse: (field: string) => LeafRecord[K] | Promise<LeafRecord[K]>) {
		const field = await storage.get(`${keyPrefix}:${key}`)
		if (field !== undefined) result[key] = await parse(field)
	}
	await Promise.all([
		readField("payloadCID", CID.parse),
		readField("blockNumber", (field) => parseInt(field, 10)),
		readField("previousInsertBlockNumber", (field) => parseInt(field, 10)),
		readField("mergeLeftHashes", (field) => JSON.parse(field).map(CID.parse)),
		readField("rootCidAfterInsert", CID.parse),
		readField("insertionTrail", stringToCidDataPairArray),
		readField("peaksWithHeightsAfterInsert", stringToPeakWithHeightArray),
	])
	return result
}
