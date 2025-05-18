/**
 * Helper functions for generating consistent DB keys
 */

import { EthereumAddress } from "../ethereum/EthereumAddress"

/**
 * Generate a key for account leaf payload
 */
export function getAccountLeafPayloadKey(account: EthereumAddress, leafIndex: number): string {
	return `account:${account.toString()}:leaf:${leafIndex}:payload`
}

/**
 * Generate a key for account leaf payload CID
 */
export function getAccountLeafPayloadCIDKey(account: EthereumAddress, leafIndex: number): string {
	return `account:${account.toString()}:leaf:${leafIndex}:payloadCID`
}

/**
 * Generate a key for account leaf root CID after insert
 */
export function getAccountLeafRootCIDAfterInsertKey(account: EthereumAddress, leafIndex: number): string {
	return `account:${account.toString()}:leaf:${leafIndex}:rootCidAfterInsert`
}

/**
 * Generate a key for account leaf insertion trail
 */
export function getAccountLeafInsertionTrailKey(account: EthereumAddress, leafIndex: number): string {
	return `account:${account.toString()}:leaf:${leafIndex}:insertionTrail`
}

/**
 * Generate a key prefix for all account leaf records
 */
export function getAccountLeafKeyPrefix(account: EthereumAddress): string {
	return `account:${account.toString()}:leaf:`
}

/**
 * Generate a key for account leaf record
 */
export function getAccountLeafRecordKey(account: EthereumAddress, leafIndex: number): string {
	return `account:${account.toString()}:leaf:${leafIndex}`
}
