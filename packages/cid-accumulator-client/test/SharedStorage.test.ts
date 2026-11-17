import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import { setImmediate } from "node:timers/promises"
import { createLightClient } from "../source/core/lightClient/createLightClient.js"
import { JSMapAdapter } from "../source/storage/adapters/JSMapAdapter.js"
import { putLeafRecordInDB } from "../source/storage/utils.js"
import { blockHeader } from "./mockChain.js"

async function fixture(t: TestContext) {
	const directory = await fs.mkdtemp(join(tmpdir(), "cid-shared-storage-"))
	t.after(() => fs.rm(directory, { recursive: true, force: true }))
	return { directory, filePath: join(directory, "database.json") }
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("shared JSON database storage", { concurrency: false, timeout: 10000 }, () => {
	test("consumer contracts and chain IDs have isolated caches while providers for the same chain share updates", async (t) => {
		const { filePath } = await fixture(t)
		const configs = [
			{ accumulatorContractAddress: "0x" + "11".repeat(20), ethereumHttpRpcUrl: "https://first.example.test" },
			{ accumulatorContractAddress: "0x" + "22".repeat(20), ethereumHttpRpcUrl: "https://first.example.test" },
			{ accumulatorContractAddress: "0x" + "11".repeat(20), ethereumHttpRpcUrl: "https://first.example.test" },
		]
		const clients = await Promise.all(configs.map(accumulatorContractConfig =>
			createLightClient({ nodeDbPath: filePath, accumulatorContractConfig })
		))
		for (const [index, client] of clients.entries()) {
			t.mock.method(client.accumulatorContract, "getChainId", async () => index === 2 ? 2n : 1n)
		}
		await Promise.all(clients.map(client => client.storage.init()))
		await Promise.all(clients.map(async (client, index) => {
			await putLeafRecordInDB(client.storage, client.account, 0, {
				account: client.account, leafIndex: 0, payload: new Uint8Array(32).fill(index + 1),
			})
			await client.storage.put("chain:head", `head-${index}`)
		}))
		await Promise.all(clients.map(client => client.storage.close()))
		for (const [index, client] of clients.entries()) {
			assert.equal(await client.getPayload(0), (index + 1).toString(16).padStart(2, "0").repeat(32))
			assert.equal(await client.storage.get("chain:head"), `head-${index}`)
			assert.deepEqual(await Array.fromAsync(client.storage.iterate("chain:")), [{ key: "chain:head", value: `head-${index}` }])
		}
		const peer = await createLightClient({ nodeDbPath: filePath, accumulatorContractConfig: {
			...configs[0], ethereumHttpRpcUrl: "https://another-provider.example.test",
		} })
		t.mock.method(peer.accumulatorContract, "getChainId", async () => 1n)
		assert.equal(await peer.getPayload(0), "01".repeat(32))
		assert.equal(await peer.storage.getIdentity!(), await clients[0].storage.getIdentity!())
		assert.notEqual(await clients[0].storage.getIdentity!(), await clients[1].storage.getIdentity!())
		assert.notEqual(await clients[0].storage.getIdentity!(), await clients[2].storage.getIdentity!())
		await peer.storage.delete("chain:head")
		assert.equal(await clients[0].storage.get("chain:head"), undefined)
		assert.equal(await clients[1].storage.get("chain:head"), "head-1")
		assert.equal(Object.keys(JSON.parse(await fs.readFile(filePath, "utf8"))).length, 11)

		// Recovery uses the active peer's provider while notifying every client in the shared scope.
		const firstChain = await clients[0].chain
		const peerChain = await peer.chain
		const resets = [0, 0]
		const rollbacks: number[][] = [[], []]
		for (const [index, chain] of [firstChain, peerChain].entries()) {
			t.after(chain.subscribeReset(() => { resets[index]++ }))
			t.after(chain.subscribeRollback(event => { rollbacks[index].push(event.firstInvalidLeafIndex) }))
		}
		await peer.storage.put("chain:head", JSON.stringify(blockHeader(1)))
		await peer.storage.put("chain:finalized", JSON.stringify(blockHeader(0)))
		await peer.storage.put("chain:block:0", JSON.stringify(blockHeader(0)))
		await peer.storage.put("chain:block:1", JSON.stringify(blockHeader(1)))
		await peerChain.trackAccount(peer.account, 1, 1)
		clients[0].storage.stop()
		clients[0].accumulatorContract.stop()
		t.mock.method(clients[0].accumulatorContract, "getChainId", async () => { throw new Error("First provider stopped") })
		t.mock.method(clients[0].accumulatorContract, "getBlock", async () => { throw new Error("First provider stopped") })
		t.mock.method(peer.accumulatorContract, "getBlock", async () => blockHeader(0))
		t.mock.method(peer.accumulatorContract, "getState", async () => ({
			meta: { leafCount: 0, peakCount: 0, peakHeights: [], previousInsertBlockNumber: 0, deployBlockNumber: 0 },
			peaks: [],
		}))
		const snapshot = await peerChain.snapshot()
		assert.deepEqual(snapshot.block, blockHeader(0))
		assert.equal(firstChain.generation, snapshot.generation)
		assert.deepEqual(resets, [2, 2])
		assert.deepEqual(rollbacks, [[0], [0]])
		assert.equal(await peer.getPayload(0), undefined)
		assert.equal(await clients[1].getPayload(0), "02".repeat(32))
	})

	test("relative, absolute, and dot-segment paths share updates and deletions", async (t) => {
		const { directory, filePath } = await fixture(t)
		const absolute = new JSMapAdapter(filePath)
		const relativePath = new JSMapAdapter(relative(process.cwd(), filePath))
		const dotSegments = new JSMapAdapter(`${directory}/nested/../database.json`)
		await Promise.all([absolute.open(), relativePath.open(), dotSegments.open()])
		await absolute.put("FIRST", "one")
		assert.equal(await relativePath.get("first"), "one")
		await relativePath.put("second", "two")
		await dotSegments.delete("FIRST")
		assert.equal(await absolute.get("first"), undefined)
		assert.equal(await absolute.get("second"), "two")
		const entries = []
		for await (const entry of dotSegments.iterate("")) entries.push(entry)
		assert.deepEqual(entries, [{ key: "second", value: "two" }])
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { second: "two" })
	})

	test("peer writes serialize, late opens preserve pending changes, and close waits for the queue", async (t) => {
		const { filePath } = await fixture(t)
		const first = new JSMapAdapter(filePath)
		const second = new JSMapAdapter(filePath)
		await Promise.all([first.open(), second.open()])
		await first.put("base", "committed")
		const writeFile = fs.writeFile
		const writing = deferred()
		const release = deferred()
		let calls = 0
		let activeWrites = 0
		let maxActiveWrites = 0
		t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
			const pause = ++calls === 1
			maxActiveWrites = Math.max(maxActiveWrites, ++activeWrites)
			try {
				await writeFile(...args)
				if (pause) {
					writing.resolve()
					await release.promise
				}
			} finally {
				activeWrites--
			}
		})
		const pending = [first.put("first", "one")]
		let closed = false
		try {
			await writing.promise
			pending.push(second.put("second", "two"), second.delete("base"))
			pending.push(
				second.close().then(() => {
					closed = true
				})
			)
			await setImmediate()
			const late = new JSMapAdapter(filePath)
			await late.open()
			assert.equal(await late.get("first"), "one")
			assert.equal(await late.get("second"), "two")
			assert.equal(await late.get("base"), undefined)
			assert.equal(closed, false)
			assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { base: "committed" })
		} finally {
			release.resolve()
			await Promise.all(pending)
		}
		assert.equal(closed, true)
		assert.equal(maxActiveWrites, 1)
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { first: "one", second: "two" })
	})

	test("a peer can persist dirty data after a failed write without reloading stale disk contents", async (t) => {
		const { filePath } = await fixture(t)
		const first = new JSMapAdapter(filePath)
		await first.open()
		await first.put("payload", "committed")
		const failure = new Error("Simulated rename failure")
		t.mock.method(
			fs,
			"rename",
			async () => {
				throw failure
			},
			{ times: 1 }
		)
		await assert.rejects(first.put("payload", "pending"), (error) => error === failure)
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { payload: "committed" })

		const second = new JSMapAdapter(filePath)
		await Promise.all([first.open(), second.open()])
		assert.equal(await first.get("payload"), "pending")
		assert.equal(await second.get("payload"), "pending")
		await second.put("recovered", "yes")
		assert.equal(await first.get("recovered"), "yes")
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { payload: "pending", recovered: "yes" })
	})

	test("concurrent failed opens share a load and can retry after the file is repaired", async (t) => {
		const { filePath } = await fixture(t)
		await fs.writeFile(filePath, "invalid JSON", "utf8")
		const first = new JSMapAdapter(filePath)
		const second = new JSMapAdapter(filePath)
		const readFile = fs.readFile
		let reads = 0
		t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
			if (args[0] === filePath) reads++
			return readFile(...args)
		})
		const results = await Promise.allSettled([first.open(), second.open()])
		for (const result of results) {
			assert.equal(result.status, "rejected")
			if (result.status === "rejected") assert.ok(result.reason instanceof SyntaxError)
		}
		assert.equal(reads, 1)
		assert.equal(await readFile(filePath, "utf8"), "invalid JSON")
		await fs.writeFile(filePath, JSON.stringify({ existing: "kept" }), "utf8")
		await Promise.all([first.open(), second.open()])
		assert.equal(reads, 2)
		assert.equal(await second.get("existing"), "kept")
		await second.put("new", "added")
		assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), { existing: "kept", new: "added" })
	})

	test("closing or stopping one adapter leaves its peer usable", async (t) => {
		const { filePath } = await fixture(t)
		const first = new JSMapAdapter(filePath)
		const second = new JSMapAdapter(filePath)
		await Promise.all([first.open(), second.open()])
		await first.put("first", "one")
		await first.close()
		first.stop()
		await second.put("second", "two")
		await second.close()
		assert.equal(await first.get("second"), "two")
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { first: "one", second: "two" })
	})

	test("different database files keep independent contents", async (t) => {
		const { directory, filePath } = await fixture(t)
		const otherPath = join(directory, "other.json")
		const first = new JSMapAdapter(filePath)
		const second = new JSMapAdapter(otherPath)
		await Promise.all([first.open(), second.open()])
		await Promise.all([first.put("payload", "one"), second.put("payload", "two")])
		await first.delete("payload")
		assert.equal(await second.get("payload"), "two")
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), {})
		assert.deepEqual(JSON.parse(await fs.readFile(otherPath, "utf8")), { payload: "two" })
	})

	test("put without an explicit open loads existing entries before changing the shared store", async (t) => {
		const { filePath } = await fixture(t)
		await fs.writeFile(filePath, JSON.stringify({ existing: "kept", remove: "old" }), "utf8")
		const first = new JSMapAdapter(filePath)
		await first.put("new", "added")
		const second = new JSMapAdapter(filePath)
		await second.delete("remove")
		assert.equal(await first.get("existing"), "kept")
		assert.equal(await first.get("remove"), undefined)
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { existing: "kept", new: "added" })
	})
})
