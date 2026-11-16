import type { TestContext } from "node:test"
import type { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import type { ChainBlock } from "../source/ethereum/events.types.js"
import type { Storage } from "../source/storage/interface.js"

export function blockHeader(number: number): ChainBlock {
	return {
		number,
		hash: "0x" + (number + 1).toString(16).padStart(64, "0"),
		parentHash: "0x" + number.toString(16).padStart(64, "0"),
	}
}

/** Deterministic headers for existing fixtures whose getBlockNumber mock advances the tip. */
export async function initializeChain(storage: Storage): Promise<void> {
	if (await storage.get("chain:head")) return
	const genesis = JSON.stringify(blockHeader(0))
	await Promise.all(["chain:head", "chain:finalized", "chain:block:0"].map((key) => storage.put(key, genesis)))
}

export function mockChain(t: TestContext, contract: AccumulatorContract, storage?: Storage): void {
	t.mock.method(contract, "getBlockNumber", async () => 100)
	t.mock.method(contract, "getBlock", async (block: number | "latest" | "finalized") => {
		if (storage) await initializeChain(storage)
		return blockHeader(typeof block === "number" ? block : block === "finalized" ? 0 : await contract.getBlockNumber())
	})
	t.mock.method(contract, "getBlockByHash", async (hash: string) => blockHeader(Number(BigInt(hash) - 1n)))
}
