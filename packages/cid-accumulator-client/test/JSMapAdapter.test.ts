import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import { setImmediate } from "node:timers/promises"
import { JSMapAdapter } from "../source/storage/adapters/JSMapAdapter.js"

async function createFixture(t: TestContext) {
	const directory = await fs.mkdtemp(join(tmpdir(), "cid-storage-test-"))
	t.after(() => fs.rm(directory, { recursive: true, force: true }))
	const filePath = join(directory, "nested", "database.json")
	const adapter = new JSMapAdapter(filePath)
	await adapter.open()
	return { adapter, filePath }
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe("JSMapAdapter persistence", { concurrency: false, timeout: 10000 }, () => {
	test("concurrent mutations survive reopening with the latest values", async (t) => {
		const { adapter, filePath } = await createFixture(t)
		const expected: Record<string, string> = {}
		const writes: Promise<void>[] = []
		for (let i = 0; i < 24; i++) {
			const key = `entry-${i}`
			expected[key] = `${i}:` + "x".repeat(16384)
			writes.push(adapter.put(key, expected[key]))
		}
		writes.push(adapter.put("REPLACED", "x".repeat(1024 * 1024)))
		writes.push(adapter.put("replaced", "latest"))
		expected.replaced = "latest"
		writes.push(adapter.delete("ENTRY-3"))
		delete expected["entry-3"]
		writes.push(adapter.persist(), adapter.close())
		await Promise.all(writes)

		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), expected)
		const reopened = new JSMapAdapter(filePath)
		await reopened.open()
		for (const [key, value] of Object.entries(expected)) {
			assert.equal(await reopened.get(key), value)
		}
		assert.equal(await reopened.get("entry-3"), undefined)
	})

	test("keeps committed data readable during a write and close waits for queued changes", async (t) => {
		const { adapter, filePath } = await createFixture(t)
		await adapter.put("payload", "committed")
		const writeFile = fs.writeFile
		const firstWriteReady = deferred()
		const releaseFirstWrite = deferred()
		let writeCount = 0
		let activeWrites = 0
		let maxActiveWrites = 0
		t.mock.method(fs, "writeFile", async (...args: Parameters<typeof fs.writeFile>) => {
			const firstWrite = ++writeCount === 1
			maxActiveWrites = Math.max(maxActiveWrites, ++activeWrites)
			try {
				await writeFile(...args)
				if (firstWrite) {
					firstWriteReady.resolve()
					await releaseFirstWrite.promise
				}
			} finally {
				activeWrites--
			}
		})

		const pending = [adapter.put("payload", "x".repeat(1024 * 1024))]
		let closed = false
		try {
			await firstWriteReady.promise
			pending.push(adapter.put("payload", "latest"), adapter.put("remove-me", "temporary"))
			pending.push(adapter.delete("remove-me"))
			pending.push(adapter.close().then(() => {
				closed = true
			}))
			await setImmediate()
			assert.equal(closed, false)
			assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { payload: "committed" })
		} finally {
			releaseFirstWrite.resolve()
			await Promise.all(pending)
		}

		assert.equal(closed, true)
		assert.equal(maxActiveWrites, 1)
		assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { payload: "latest" })
		assert.deepEqual(await fs.readdir(dirname(filePath)), ["database.json"])
	})

	for (const failure of ["write", "rename"] as const) {
		test(`a ${failure} failure preserves the database, cleans up, and allows a retry`, async (t) => {
			const { adapter, filePath } = await createFixture(t)
			await adapter.put("payload", "committed")
			const error = new Error(`Simulated ${failure} failure`)
			if (failure === "write") {
				const writeFile = fs.writeFile
				t.mock.method(fs, "writeFile", async (file: Parameters<typeof fs.writeFile>[0]) => {
					await writeFile(file, '{"payload":', "utf8")
					throw error
				}, { times: 1 })
			} else {
				t.mock.method(fs, "rename", async () => {
					throw error
				}, { times: 1 })
			}

			await assert.rejects(adapter.put("payload", "pending"), error)
			assert.deepEqual(JSON.parse(await fs.readFile(filePath, "utf8")), { payload: "committed" })
			assert.deepEqual(await fs.readdir(dirname(filePath)), ["database.json"])

			await adapter.persist()
			await adapter.put("recovered", "yes")
			const reopened = new JSMapAdapter(filePath)
			await reopened.open()
			assert.equal(await reopened.get("payload"), "pending")
			assert.equal(await reopened.get("recovered"), "yes")
			assert.deepEqual(await fs.readdir(dirname(filePath)), ["database.json"])
		})
	}
})
