import { sha256 } from "../utils/hash.js"
import type { DagCborEncodedData, IpldNode } from "./types.js"
import { CID } from "./CID.js"
import { hashToMultiformatsDigest, isInternalNode, isIpldLink } from "../utils/codec.js"
import * as dagCbor from "../utils/dagCbor.js"

/**
 * Handle IPFS API responses
 * @param res - The fetch Response object
 * @param endpoint - The IPFS API endpoint that was called
 * @returns The parsed response data
 */
export async function handleIpfsResponse(res: Response, endpoint: string): Promise<any> {
	if (!res.ok) {
		const msg = await res.text().catch(() => res.statusText)
		throw new Error(`IPFS ${endpoint} failed: ${res.status} ${msg}`)
	}

	const contentType = res.headers.get("Content-Type") || ""
	if (contentType.includes("application/json")) return res.json()
	return res.text()
}

/**
 * Send a binary payload to IPFS (used for block/put)
 * @param baseUrl - Base URL of the IPFS HTTP API
 * @param endpoint - The IPFS API endpoint to call
 * @param params - Query parameters to include in the request
 * @param body - Binary data to send
 * @returns The parsed response data
 */
export async function postIpfsBinary(
	baseUrl: string,
	endpoint: string,
	params: Record<string, string>,
	body: Uint8Array
): Promise<any> {
	const url = new URL(`${baseUrl}/${endpoint}`)
	for (const [key, val] of Object.entries(params)) {
		url.searchParams.set(key, val)
	}

	const formData = new FormData()
	const blob = new Blob([new Uint8Array(body)], { type: "application/octet-stream" })
	formData.append("data", blob)

	const res = await fetch(url.toString(), {
		method: "POST",
		body: formData,
	})

	return handleIpfsResponse(res, endpoint)
}

/**
 * Send a no-body request to IPFS API
 * @param baseUrl - Base URL of the IPFS HTTP API
 * @param endpoint - The IPFS API endpoint to call
 * @param params - Query parameters to include in the request
 * @returns The parsed response data
 */
export async function postIpfsEmpty(
	baseUrl: string,
	endpoint: string,
	params: Record<string, string> = {}
): Promise<any> {
	// Make sure we don't have double slashes between baseUrl and endpoint
	const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl
	const path = endpoint.startsWith("/") ? endpoint : "/" + endpoint

	// Construct URL with parameters using URLSearchParams
	const searchParams = new URLSearchParams()
	for (const [key, val] of Object.entries(params)) {
		searchParams.append(key, val)
	}

	// Full request URL
	const url = `${base}${path}`
	const fullUrl = `${url}?${searchParams}`

	// Create a standard form for POST (this is how the CLI works)
	const formData = new FormData()

	// Most IPFS API endpoints expect the parameters in the URL, not the body
	try {
		const res = await fetch(fullUrl, {
			method: "POST",
			// Send a proper form-based POST like the CLI does
			body: formData,
		})

		return handleIpfsResponse(res, endpoint)
	} catch (error) {
		throw error
	}
}

/**
 * Get list of remote pinning services configured in the IPFS node
 * @param baseUrl - Base URL of the IPFS HTTP API
 * @returns Array of service names
 */
export async function getRemotePinningServices(baseUrl: string): Promise<string[]> {
	try {
		// Get list of remote pinning services
		const res = await postIpfsEmpty(baseUrl, "pin/remote/service/ls")

		// Extract service names from response
		if (res?.RemoteServices && Array.isArray(res.RemoteServices)) {
			return res.RemoteServices.map((service: any) => service.Service)
		} else {
			console.warn("[IPFS] No remote pinning services found or invalid response format")
			return []
		}
	} catch (error: unknown) {
		// Log error but don't fail the overall operation
		const errorMessage = error instanceof Error ? error.message : String(error)
		console.error(`[IPFS] Error getting remote pinning services: ${errorMessage}`)
		return []
	}
}

export async function verifyCIDAgainstDagCborEncodedData(
	dagCborEncodedData: DagCborEncodedData,
	expectedCID: CID<unknown, 113, 18, 1>
): Promise<boolean> {
	const hash = await sha256(dagCborEncodedData)
	const multihash = hashToMultiformatsDigest(0x12, hash) // 0x12 is the code for sha2-256
	const computedCID = CID.createV1(dagCbor.code, multihash)
	return computedCID.toString() === expectedCID.toString()
}

export async function verifyCIDAgainstDagCborEncodedDataOrThrow(
	dagCborEncodedData: DagCborEncodedData,
	expectedCID: CID<unknown, 113, 18, 1>,
	errorMessage?: string
): Promise<void> {
	const hash = await sha256(dagCborEncodedData)
	const multihash = hashToMultiformatsDigest(0x12, hash) // 0x12 is the code for sha2-256
	const computedCID = CID.createV1(dagCbor.code, multihash)
	const message: string =
		errorMessage ??
		`[Client] 💥 CID/Data pair is invalid. dagCborEncodedData: ${dagCborEncodedData}, expectedCID: ${expectedCID.toString()}, computed(actual)CID: ${computedCID.toString()}`
	if (computedCID.toString() !== expectedCID.toString()) throw new Error(message)
}

/**
 * @notice Recursively resolves a Merkle tree (DAG) from a given root CID using the provided "blockstore" map.
 * @dev This function traverses the DAG in depth-first order, decoding each IPLD node using dag-cbor.
 * If any block referenced by the DAG is missing from the blockstore, the function will return false.
 * @param cid The root CID of the Merkle tree to resolve. Must be CID.
 * @return Promise<boolean> Resolves to true if the DAG is successfully resolved, false otherwise.
 */
export async function resolveMerkleTreeFromLocalMap(cid: CID<unknown, 113, 18, 1>, cidStringToDataMap: Map<string, DagCborEncodedData>): Promise<boolean> {
	const dagCborEncodedData: DagCborEncodedData | undefined = cidStringToDataMap.get(cid.toString())
	if (!dagCborEncodedData) return false

	// you either get (NOT DagCbor encoded) leaf data, a leaf's CID, or a (NOT DagCbor encoded) link node
	const node: IpldNode = dagCbor.decode(dagCborEncodedData)

	if (node instanceof Uint8Array) {
		// then we just got a leaf
		return true
	} else if (isIpldLink(node)) {
		// then we just got a leaf's CID
		return await resolveMerkleTreeFromLocalMap(node, cidStringToDataMap)
	} else if (isInternalNode(node)) {
		// then we just got a (NOT DagCbor encoded) link node that points to a "left" CID and a "right" CID
		return (
			(await resolveMerkleTreeFromLocalMap(node.L, cidStringToDataMap)) &&
			(await resolveMerkleTreeFromLocalMap(node.R, cidStringToDataMap))
		)
	} else {
		console.error("Unexpected node structure")
		return false
	}
}
