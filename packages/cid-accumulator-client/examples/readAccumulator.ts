import { createLightClient } from "cid-accumulator-client"

// Run from the repository root after npm ci:
// npx tsx packages/cid-accumulator-client/examples/readAccumulator.ts <consumer-contract-address> [rpc-url]
// Supply the address of a deployed application such as contracts/examples/ExampleApplication.sol.
const [accumulatorContractAddress, ethereumHttpRpcUrl = "http://127.0.0.1:8545"] = process.argv.slice(2)
if (!accumulatorContractAddress) {
	throw new Error("Supply a deployed consumer contract address and, optionally, its Ethereum RPC URL")
}

const client = await createLightClient({
	accumulatorContractConfig: { accumulatorContractAddress, ethereumHttpRpcUrl },
})

try {
	await client.start()
	for await (const { index, payload } of client.iterate()) {
		console.log(`Leaf ${index}: ${payload}`)
	}
} finally {
	client.stop()
}
