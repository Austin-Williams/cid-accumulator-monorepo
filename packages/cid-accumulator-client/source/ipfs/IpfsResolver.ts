import * as dagCbor from "../utils/dagCbor.js"
import { CarReader } from './CarReader.js'
import { buildIpfsUrl, resolveMerkleTreeFromLocalMap, verifyCIDAgainstDagCborEncodedData } from "./utils.js"
import { createLogger } from "../utils/logging.js"
import { hexStringToUint8Array, isInternalNode, isIpldLink, uint8ArrayToHexString } from "../utils/codec.js"
import { RateLimiter } from "../utils/rateLimiter.js"
import { verifyCIDAgainstDagCborEncodedDataOrThrow } from "./utils.js"

import type { CID } from "./CID.js"
import type { DagCborEncodedData, IpldNode } from "./types.js"
import type { IpfsResolverConfig } from "./IpfsResolver.types.js"
import type { LifecycleComponent, Logger } from "../types/common.js"
import type { Storage } from "../storage/interface.js"

// Used to get IPFS blocks and resolve IPFS dags
export class IpfsResolver implements LifecycleComponent {
	private gatewayUrl: string
	private storage: Storage
	private rateLimiter: RateLimiter
	private logger: Logger

	constructor(storage: Storage, config: Required<IpfsResolverConfig>) {
		this.storage = storage
		this.gatewayUrl = config.gatewayUrl
		this.rateLimiter = new RateLimiter(config.rateLimiterOptions)
		this.logger = createLogger("UniversalIpfsResolver")
	}

	/**
	 * @notice Retrieves a block by CID from local DB or IPFS.
	 * @param cid The CID of the block to retrieve
	 * @return The verified block, or undefined if unavailable after the configured retries.
	 * @dev Stores any blocks retrieved from IPFS in the local DB if it is not already present.
	 * @dev The DagCborEncodedData can be decoded via dagCbor.decode.
	 */
	public async getBlock(cid: CID<unknown, 113, 18, 1>, localStorageOnly: boolean = false): Promise<DagCborEncodedData | undefined> {
		// Check if we already have this CID in the local DB
		const cidString = cid.toString()
		const key = `ipfs:block:${cidString}`

		// Try to get from local storage first
		const cachedData = await this.storage.get(key)
		if (cachedData) {
			const data = hexStringToUint8Array(cachedData) as DagCborEncodedData
			await verifyCIDAgainstDagCborEncodedDataOrThrow(
				data,
				cid,
				`IPFS Cache returned invalid data! This should never happen.`
			)

			return data
		}
		if (localStorageOnly) return undefined

		// Each download attempt gets its own timeout and abort signal.
		const url = buildIpfsUrl(this.gatewayUrl, `ipfs/${cid.toString()}`).toString()
		const fetchBlock = async () => {
			const controller = new AbortController()
			const timeoutId = setTimeout(() => controller.abort(), 5000)
			try {
				const res = await fetch(url, { method: "GET", signal: controller.signal })
				if (!res.ok) throw new Error(`IPFS block/get failed: ${res.status} ${res.statusText}`)
				const data: DagCborEncodedData = new Uint8Array(await res.arrayBuffer()) as DagCborEncodedData

				// Verify that we actually got what we asked for
				await verifyCIDAgainstDagCborEncodedDataOrThrow(
					data,
					cid,
					`IPFS Gateway returned invalid data! This should never happen`
				)

				// Cache the data in the local DB
				await this.storage.put(key, uint8ArrayToHexString(data))

				return data
			} finally {
				clearTimeout(timeoutId)
			}
		}

		try {
			return await this.rateLimiter.execute(fetchBlock)
		} catch (error: unknown) {
			if (error instanceof Error && error.name === "AbortError") {
				this.logger.warn(`Fetch timed out after 5000ms for ${url}`)
			} else {
				this.logger.error(`Error fetching block ${cid.toString()}: ${error}`)
			}
			return undefined
		}
	}

	/**
	 * @notice Resolves every block reachable from a root CID using the cache, a CAR file, or individual block requests.
	 * @dev Returns undefined if any referenced block remains unavailable, so callers can try another data source.
	 * @param cid The root CID of the Merkle tree to resolve. Must be CID.
	 * @return An iterable of leaf payloads in order if the entire DAG was resolved, or undefined otherwise.
	 */
	public async fullyResolveCID(
		cid: CID<unknown, 113, 18, 1>
	): Promise<AsyncIterable<{ leafIndex: number; payload: Uint8Array }> | undefined> {
		// Try to resolve the root CID using local storage only
		const resolvedViaLocalStorage = await this.resolveMerkleTree(cid, true)
		if (resolvedViaLocalStorage) {
			this.logger.log(`Resolved the root CID using local storage only`)
			return this.createPayloadsAsyncIterable(cid)
		}

		// Try to resolve the root CID by fetching a CAR file from the IPFS gateway
		const resolvedViaCarFile = await this.getAndCacheMerkleTreeViaCarFile(cid)
		if (resolvedViaCarFile) {
			this.logger.log(`Fetched all data for the root CID with a single call to the IPFS gateway for a CAR file.`)
			return this.createPayloadsAsyncIterable(cid)
		} else {
			this.logger.warn(`Failed to fetch CAR file from IPFS gateway. Falling back to asking for individual IPFS blocks.`)
		}

		// Try individual blocks if the cache and CAR download could not resolve the entire tree.
		const resolved = await this.resolveMerkleTree(cid)

		if (!resolved) return undefined

		// Create an AsyncIterable that will decode and yield each leaf node
		const payloadsAsyncIterable = this.createPayloadsAsyncIterable(cid)

		return payloadsAsyncIterable
	}

	/**
	 * @notice Clears the local IPFS block cache to reduce database size
	 * @dev This removes all entries with keys starting with "ipfs:block:" from the database
	 * @dev This will cause the adapter to re-fetch blocks from the IPFS gateway when needed
	 * @param options Optional parameters
	 * @param options.cidFilter If provided, only clears blocks with CIDs matching this filter function
	 * @returns The number of entries deleted from the database
	 */
	public async clearBlockCache(options?: { cidFilter?: (cid: string) => boolean }): Promise<number> {
		let deletedCount = 0
		const keysToDelete: string[] = []

		// Iterate through all keys in the database with the ipfs:block: prefix
		for await (const { key } of this.storage.iterate("ipfs:block:")) {
			let shouldDelete = true

			// Apply CID filter if specified
			if (options?.cidFilter) {
				// Extract CID from the key (format is ipfs:block:{cidString})
				const cidMatch = key.match(/^ipfs:block:(.+)$/)
				if (cidMatch) {
					const cid = cidMatch[1]

					// Skip if the CID doesn't match the filter
					if (!options.cidFilter(cid)) {
						shouldDelete = false
					}
				}
			}

			if (shouldDelete) {
				keysToDelete.push(key)
			}
		}

		// Delete all marked keys
		for (const key of keysToDelete) {
			await this.storage.delete(key)
			deletedCount++
		}

		this.logger.log(`Cleared ${deletedCount} block cache entries`)
		return deletedCount
	}

	private async getAndCacheMerkleTreeViaCarFile(rootCid: CID<unknown, 113, 18, 1>): Promise<boolean> {
		const url = buildIpfsUrl(this.gatewayUrl, `ipfs/${rootCid.toString()}`, { format: "car" }).toString()
		const controller = new AbortController()
		const timeoutId = setTimeout(() => controller.abort(), 15000)
		try {
			this.logger.log(`Attempting to fetch CAR file for root CID ${rootCid.toString()}...`)
			const res = await fetch(url, { method: "GET", signal: controller.signal })
			if (!res.ok) throw new Error(`IPFS block/get failed: ${res.status} ${res.statusText}`)
			this.logger.log(`Fetched CAR file for root CID ${rootCid.toString()}. Verifying its contents...`)
			const carBytes = new Uint8Array(await res.arrayBuffer())

			// Parse the CAR file and store CIDs and their data in a Map
			const carReader = await CarReader.fromBytes(carBytes)
			const cidStringToDataMap = new Map<string, DagCborEncodedData>()

			// Verify each block before checking whether the CAR contains the complete requested tree.
			for await (const block of carReader.blocks()) {
				const computedCID = await verifyCIDAgainstDagCborEncodedData(block.bytes as DagCborEncodedData, block.cid as CID<unknown, 113, 18, 1>)
				if (!computedCID) throw new Error(`CID/Data pair is invalid. dagCborEncodedData: ${block.bytes}, expectedCID: ${block.cid.toString()}`)
				cidStringToDataMap.set(block.cid.toString(), block.bytes as DagCborEncodedData)
			}

			// CAR blocks may arrive in any order. Validate the requested root after reading them all.
			if (!(await resolveMerkleTreeFromLocalMap(rootCid, cidStringToDataMap))) {
				throw new Error(`Could not resolve the root CID with the CAR file`)
			}

			// Cache the verified tree.
			for (const [cid, data] of cidStringToDataMap.entries()) {
				const key = `ipfs:block:${cid}`
				await this.storage.put(key, uint8ArrayToHexString(data))
			}

			return true
		} catch (error: unknown) {
			if ((error as any).name === "AbortError") {
				this.logger.warn(`Fetch timed out for ${url}`)
			} else {
				this.logger.error(`Error fetching CAR file for root CID ${rootCid.toString()}: ${error}`)
			}
		} finally {
			clearTimeout(timeoutId)
		}
		return false
	}

	/**
	 * @notice Creates an AsyncIterable that yields each leaf node in the Merkle tree
	 * @dev This creates an iterable that can be used with for-await-of loops to efficiently process leaf nodes
	 * without loading the entire tree into memory at once
	 * @param rootCid The root CID of the Merkle tree
	 * @return AsyncIterable that yields objects with leafIndex and payload
	 */
	private createPayloadsAsyncIterable(
		rootCid: CID<unknown, 113, 18, 1>
	): AsyncIterable<{ leafIndex: number; payload: Uint8Array }> {
		// Keep track of the current leaf index
		let leafIndex = 0

		// Stack for DFS traversal
		const stack: CID<unknown, 113, 18, 1>[] = [rootCid]

		// Store a reference to this instance for use in the iterator
		const adapter = this

		// Return an async iterable with its iterator
		return {
			// Symbol.asyncIterator makes this an AsyncIterable
			[Symbol.asyncIterator]() {
				// Return an AsyncIterator
				return {
					async next(): Promise<IteratorResult<{ leafIndex: number; payload: Uint8Array }>> {
						// If stack is empty, we're done
						if (stack.length === 0) {
							return { done: true, value: undefined }
						}

						// Get the next CID to process
						const cid = stack.pop()!

						try {
							// Get the DagCborEncodedData for the ipfs block
							const dagCborEncodedData = await adapter.getBlock(cid)

							if (!dagCborEncodedData) throw new Error(`Could not get block for CID ${cid.toString()}`)

							// Decode the node
							const node: IpldNode = dagCbor.decode(dagCborEncodedData)

							if (node instanceof Uint8Array) {
								// It's a leaf node, return it with the current index, then increment for next time
								const currentIndex = leafIndex
								leafIndex += 1 // Increment for the next leaf

								return { done: false, value: { leafIndex: currentIndex, payload: node } }
							} else if (isIpldLink(node)) {
								// It's a link to another node, add it to the stack
								stack.push(node)
								// Recursively call next() to process this node
								return this.next()
							} else if (isInternalNode(node)) {
								// It's an internal node with left and right children
								// Add right first so left is processed first (stack is LIFO)
								stack.push(node.R)
								stack.push(node.L)

								// Recursively call next() to process the next node
								return this.next()
							} else {
								throw new Error("Unexpected node structure in next()")
							}
						} catch (error) {
							adapter.logger.error(`Error processing CID ${cid.toString()}: ${error}`)

							throw error
						}
					},

					/**
					 * @notice Handles early termination of iteration
					 * @dev Called when a for-await-of loop is broken out of, or when a generator is manually closed
					 * @param _value Optional value to return (unused but required by AsyncIterator interface)
					 * @return Promise that resolves to an IteratorResult indicating completion
					 */
					async return(_value?: any): Promise<IteratorResult<{ leafIndex: number; payload: Uint8Array }>> {
						// Clean up resources
						adapter.logger.log(`Iterator returned early, cleaning up resources`)
						stack.length = 0
						return { done: true, value: undefined }
					},

					/**
					 * @notice Handles errors during iteration
					 * @dev Called when an error is thrown during iteration
					 * @param error The error that was thrown
					 * @return Promise that rejects with the error after cleanup
					 */
					async throw(error?: any): Promise<IteratorResult<{ leafIndex: number; payload: Uint8Array }>> {
						// Clean up resources
						adapter.logger.error(`Error in iterator, cleaning up resources: ${error}`)
						stack.length = 0
						throw error || new Error("Iterator terminated with an error")
					},
				}
			},
		}
	}

	/**
	 * @notice Recursively resolves a Merkle tree (DAG) from a given root CID.
	 * @dev This function traverses the DAG in depth-first order, decoding each IPLD node using dag-cbor.
	 * If any block referenced by the DAG is missing from local storage AND cannot be fetched by the IPFS gateway, then this function will return false.
	 * @param cid The root CID of the Merkle tree to resolve. Must be CID.
	 * @return Promise<boolean> Resolves to true if the DAG is successfully resolved, false otherwise
	 */
	private async resolveMerkleTree(cid: CID<unknown, 113, 18, 1>, localStorageOnly: boolean = false): Promise<boolean> {
		const dagCborEncodedData = await this.getBlock(cid, localStorageOnly)
		if (!dagCborEncodedData) return false

		// you either get (NOT DagCbor encoded) leaf data, a leaf's CID, or a (NOT DagCbor encoded) link node
		const node: IpldNode = dagCbor.decode(dagCborEncodedData)

		if (node instanceof Uint8Array) {
			// then we just got a leaf
			return true
		} else if (isIpldLink(node)) {
			// then we just got a leaf's CID
			return await this.resolveMerkleTree(node, localStorageOnly)
		} else if (isInternalNode(node)) {
			// then we just got a (NOT DagCbor encoded) link node that points to a "left" CID and a "right" CID
			return (
				(await this.resolveMerkleTree(node.L, localStorageOnly)) &&
				(await this.resolveMerkleTree(node.R, localStorageOnly))
			)
		} else {
			this.logger.error("Unexpected node structure")
			return false
		}
	}

	// Lifecycle functions
	async init(): Promise<void> {
		// noop
		return
	}

	async start(): Promise<void> {
		// noop
		return
	}

	stop(): void {
		this.rateLimiter.clearQueue()
	}
}
