import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import { RateLimiter } from "../source/utils/rateLimiter.js"

function fixture(t: TestContext, maxRetries: number) {
	t.mock.method(console, "error", () => {})
	return new RateLimiter({ intervalMs: 0, maxRetries, baseDelay: 0, capDelay: 0 })
}

describe("rate limiter retry limits", { concurrency: false, timeout: 5000 }, () => {
	test("a successful operation runs once and returns its result", async (t) => {
		const limiter = fixture(t, 2)
		const expected = { value: "success" }
		let attempts = 0
		const result = await limiter.execute(async () => {
			attempts++
			return expected
		})
		assert.equal(result, expected)
		assert.equal(attempts, 1)
	})

	for (const maxRetries of [0, 1, 2]) {
		test(`maxRetries ${maxRetries} allows ${maxRetries + 1} attempts and rejects with the last error`, async (t) => {
			const limiter = fixture(t, maxRetries)
			const errors: Error[] = []
			await assert.rejects(
				limiter.execute(async () => {
					const error = new Error(`Failure ${errors.length + 1}`)
					errors.push(error)
					throw error
				}),
				(error) => error === errors[errors.length - 1]
			)
			assert.equal(errors.length, maxRetries + 1)
		})
	}

	test("an operation can succeed on its final allowed attempt", async (t) => {
		const limiter = fixture(t, 2)
		let attempts = 0
		const result = await limiter.execute(async () => {
			attempts++
			if (attempts < 3) throw new Error("Temporary failure")
			return "recovered"
		})
		assert.equal(result, "recovered")
		assert.equal(attempts, 3)
	})

	test("an operation cannot succeed after its retry budget is exhausted", async (t) => {
		const limiter = fixture(t, 2)
		const failure = new Error("Retry budget exhausted")
		let attempts = 0
		await assert.rejects(
			limiter.execute(async () => {
				attempts++
				if (attempts <= 3) throw failure
				return "too late"
			}),
			(error) => error === failure
		)
		assert.equal(attempts, 3)
	})

	test("queued tasks run in order after a failure, each with its own retry budget", async (t) => {
		const limiter = fixture(t, 2)
		const failure = new Error("First task failed")
		const order: string[] = []
		let firstAttempts = 0
		let secondAttempts = 0
		const first = limiter.execute(async () => {
			order.push(`first:${++firstAttempts}`)
			throw failure
		})
		const second = limiter.execute(async () => {
			order.push(`second:${++secondAttempts}`)
			if (secondAttempts < 3) throw new Error("Second task temporary failure")
			return "second result"
		})
		const third = limiter.execute(async () => {
			order.push("third:1")
			return "third result"
		})
		assert.equal(limiter.getQueueLength(), 2)
		assert.deepEqual(await Promise.allSettled([first, second, third]), [
			{ status: "rejected", reason: failure },
			{ status: "fulfilled", value: "second result" },
			{ status: "fulfilled", value: "third result" },
		])
		assert.deepEqual(order, ["first:1", "first:2", "first:3", "second:1", "second:2", "second:3", "third:1"])
		assert.equal(limiter.getQueueLength(), 0)
	})
})
