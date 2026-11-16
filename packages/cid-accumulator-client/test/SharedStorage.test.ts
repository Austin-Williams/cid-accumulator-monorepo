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
	test("two light clients preserve both accounts' records in the shared file", async (t) => {
		const { filePath } = await fixture(t)
		const first = await createLightClient("0x" + "11".repeat(20), { nodeDbPath: filePath, accumulatorContractConfig: { accumulatorContractAddress: "0x" + "ab".repeat(20) } })
		const second = await createLightClient("0x" + "22".repeat(20), { nodeDbPath: filePath, accumulatorContractConfig: { accumulatorContractAddress: "0x" + "ab".repeat(20) } })
		// Only open storage; contract and polling services remain stopped.
		await Promise.all([first.storage.init(), second.storage.init()])
		await Promise.all(
			[first, second].map((client, index) =>
				putLeafRecordInDB(client.storage, client.account, 0, {
					account: client.account,
					leafIndex: 0,
					payload: Uint8Array.of(index + 1),
				})
			)
		)
		await Promise.all([first.storage.close(), second.storage.close()])
		const saved = JSON.parse(await fs.readFile(filePath, "utf8"))
		for (const [index, client] of [first, second].entries()) {
			const prefix = `account:${client.account}:leaf:0`
			assert.equal(saved[`${prefix}:account`], client.account.toString())
			assert.equal(saved[`${prefix}:leafindex`], "0")
			assert.equal(saved[`${prefix}:payload`], index === 0 ? "01" : "02")
			assert.equal(await client.getPayload(0), index === 0 ? "01" : "02")
		}
		assert.equal(Object.keys(saved).length, 6)
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
