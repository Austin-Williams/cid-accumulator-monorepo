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

	// Store optional fields as strings if they exist
	const optionalFields: Array<[string, any, (val: any) => string]> = [
		["payloadCID", value.payloadCID, (val: CID) => val.toString()],
		["blockNumber", value.blockNumber, (val: number) => val.toString()],
		[
			"mergeLeftHashes",
			value.mergeLeftHashes,
			(val: CID<unknown, 113, 27, 1>[]) => JSON.stringify(val.map((cid) => cid.toString())),
		],
		["previousInsertBlockNumber", value.previousInsertBlockNumber, (val: number) => val.toString()],
		["rootCidAfterInsert", value.rootCidAfterInsert, (val: CID) => val.toString()],
		["insertionTrail", value.insertionTrail, cidDataPairArrayToStringForDB],
		["peaksWithHeightsAfterInsert", value.peaksWithHeightsAfterInsert, peakWithHeightArrayToStringForDB],
	]

	// Process each optional field
	await Promise.all(
		optionalFields.map(async ([fieldName, fieldValue, formatter]) => {
			if (fieldValue !== undefined) {
				await storage.put(`${keyPrefix}:${fieldName}`, formatter(fieldValue))
			}
		})
	)
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

	// Define a type for field parsers that maps directly to LeafRecord properties
	type FieldParser<K extends keyof LeafRecord> = [K, (val: string) => Promise<LeafRecord[K]> | LeafRecord[K]]

	// Define optional fields with their key names and parsing functions
	const optionalFields: FieldParser<keyof LeafRecord>[] = [
		["payloadCID", (val: string) => CID.parse(val)],
		["blockNumber", (val: string) => parseInt(val, 10)],
		["previousInsertBlockNumber", (val: string) => parseInt(val, 10)],
		["mergeLeftHashes", (val: string) => JSON.parse(val).map((cidStr: string) => CID.parse(cidStr))],
		["rootCidAfterInsert", (val: string) => CID.parse(val)],
		["insertionTrail", async (val: string) => await stringToCidDataPairArray(val)],
		["peaksWithHeightsAfterInsert", async (val: string) => await stringToPeakWithHeightArray(val)],
	]

	// Process each optional field
	const result = {
		account,
		leafIndex: leafIndex,
		payload,
	} as LeafRecord

	// Use Promise.all for parallel processing of optional fields
	await Promise.all(
		optionalFields.map(async ([fieldName, parser]) => {
			const fieldValue = await storage.get(`${keyPrefix}:${fieldName}`)
			if (fieldValue !== undefined) {
				; (result as any)[fieldName] = await parser(fieldValue)
			}
		})
	)

	return result
}
