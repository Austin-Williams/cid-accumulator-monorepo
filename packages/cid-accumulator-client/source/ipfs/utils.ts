import { keccak256 } from "../utils/hash.js"
import type { DagCborEncodedData, IpldNode } from "./types.js"
import { CID } from "./CID.js"
import { hashToMultiformatsDigest, isInternalNode, isIpldLink } from "../utils/codec.js"
import * as dagCbor from "../utils/dagCbor.js"
import { fetchWithRedactedErrors } from "../utils/http.js"

/** Append an IPFS endpoint while preserving base query parameters; request parameters take precedence. */
export function buildIpfsUrl(baseUrl: string, endpoint: string, params: Record<string, string | undefined> = {}): URL {
	const url = new URL(baseUrl)
	url.pathname = `${url.pathname.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined) url.searchParams.delete(key)
		else url.searchParams.set(key, value)
	}
	return url
}

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
	params: Record<string, string | undefined>,
	body: Uint8Array
): Promise<any> {
	const url = buildIpfsUrl(baseUrl, endpoint, params)

	const formData = new FormData()
	const blob = new Blob([new Uint8Array(body)], { type: "application/octet-stream" })
	formData.append("data", blob)

	const res = await fetchWithRedactedErrors(url.toString(), {
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
	params: Record<string, string | undefined> = {}
): Promise<any> {
	const url = buildIpfsUrl(baseUrl, endpoint, params)

	const res = await fetchWithRedactedErrors(url.toString(), { method: "POST" })
	return handleIpfsResponse(res, endpoint)
}

/**
 * Get list of remote pinning services configured in the IPFS node
 * @param baseUrl - Base URL of the IPFS HTTP API
 * @returns Array of service names
 */
export async function getRemotePinningServices(baseUrl: string): Promise<string[]> {
	const res = await postIpfsEmpty(baseUrl, "pin/remote/service/ls", { arg: undefined })
	if (
		!Array.isArray(res?.RemoteServices) ||
		!res.RemoteServices.every((service: any) => typeof service?.Service === "string" && service.Service.length > 0)
	) {
		throw new Error("[IPFS] Invalid pin/remote/service/ls response: expected a RemoteServices list")
	}
	return res.RemoteServices.map((service: { Service: string }) => service.Service)
}

export async function verifyCIDAgainstDagCborEncodedData(
	dagCborEncodedData: DagCborEncodedData,
	expectedCID: CID<unknown, 113, 27, 1>
): Promise<boolean> {
	const hash = keccak256(dagCborEncodedData)
	const multihash = hashToMultiformatsDigest(0x1b, hash) // 0x1b is the code for keccak-256
	const computedCID = CID.createV1(dagCbor.code, multihash)
	return computedCID.toString() === expectedCID.toString()
}

export async function verifyCIDAgainstDagCborEncodedDataOrThrow(
	dagCborEncodedData: DagCborEncodedData,
	expectedCID: CID<unknown, 113, 27, 1>,
	errorMessage?: string
): Promise<void> {
	const hash = keccak256(dagCborEncodedData)
	const multihash = hashToMultiformatsDigest(0x1b, hash) // 0x1b is the code for keccak-256
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
export async function resolveMerkleTreeFromLocalMap(cid: CID<unknown, 113, 27, 1>, cidStringToDataMap: Map<string, DagCborEncodedData>): Promise<boolean> {
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
