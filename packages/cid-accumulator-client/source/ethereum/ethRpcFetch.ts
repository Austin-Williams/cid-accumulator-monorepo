import type { BlockReference } from "./events.types.js"

// Makes a raw Ethereum JSON-RPC call using fetch.
// @param ethereumHttpRpcUrl string (Ethereum node endpoint)
// @param method string (JSON-RPC method)
// @param params any[] (JSON-RPC params)
// @param id number (request id, default 1)
// @returns Promise<any> (result field from response)
export async function ethRpcFetch(ethereumHttpRpcUrl: string, method: string, params: any[], id = 1): Promise<any> {
	const res = await fetch(ethereumHttpRpcUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			method,
			params,
			id,
		}),
	})
	const text = await res.text()
	let json
	try {
		json = JSON.parse(text)
	} catch {
		throw new Error(`Failed to parse JSON from Ethereum RPC response: ${text}`)
	}
	if (json.error) {
		console.error("Ethereum RPC error:", JSON.stringify(json.error, null, 2))
		throw new Error(json.error.message || JSON.stringify(json.error))
	}
	if (json.result === undefined) {
		console.error(`Received undefined result for method ${method} with params ${params}`)
		throw new Error(`Received undefined result for method ${method} with params ${params}`)
	}
	return json.result
}

// Calls a contract view function (e.g., getState, getRootCID) using eth_call.
// @param ethereumHttpRpcUrl string
// @param contractAddress string
// @param data string (ABI-encoded call data)
// @param blockTag string (default: "latest")
// @returns Promise<string> (ABI-encoded result)
export async function callContractView(
	ethereumHttpRpcUrl: string,
	contractAddress: string,
	data: string,
	blockTag: BlockReference = "latest"
) {
	return ethRpcFetch(ethereumHttpRpcUrl, "eth_call", [{ to: contractAddress, data }, blockTag])
}
