import assert from "node:assert/strict"
import { test } from "node:test"
import { inspect } from "node:util"
import { fetchWithRedactedErrors } from "../source/utils/http.js"

test("HTTP requests preserve responses and aborts while removing URLs from transport errors", async (t) => {
	const url = "https://SYNTHETIC_USER:SYNTHETIC_PASSWORD@EXAMPLE.invalid/path with space?token=SYNTHETIC_TOKEN"
	const checkError = (name: string) => (error: unknown): boolean => {
		assert.ok(error instanceof Error)
		assert.equal(error.name, name)
		assert.match(error.message, /\[redacted URL\]/)
		assert.doesNotMatch(inspect(error, { depth: null, showHidden: true }), /SYNTHETIC_|example\.invalid/i)
		assert.equal(error.cause, undefined)
		return true
	}

	// Native fetch rejects these inputs before networking; invalid URLs carry cause.input.
	await assert.rejects(fetchWithRedactedErrors(url), checkError("TypeError"))
	await assert.rejects(fetchWithRedactedErrors("invalid URL SYNTHETIC_TOKEN"), checkError("TypeError"))

	const response = new Response("already pinned", { status: 403 })
	const fetch = t.mock.method(globalThis, "fetch", async () => response)
	const options = { method: "POST", body: "request body", signal: new AbortController().signal }
	assert.equal(await fetchWithRedactedErrors(url, options), response)
	assert.deepEqual(fetch.mock.calls[0].arguments, [url, options])
	assert.equal(response.status, 403)
	assert.equal(await response.text(), "already pinned")

	fetch.mock.mockImplementation(async () => {
		throw new TypeError(`Cannot fetch ${new URL(url).href}`, { cause: new Error(url) })
	})
	await assert.rejects(fetchWithRedactedErrors(url), checkError("TypeError"))

	fetch.mock.mockImplementation(async () => {
		throw new DOMException(`Request aborted for ${url}`, "AbortError")
	})
	await assert.rejects(fetchWithRedactedErrors(url), checkError("AbortError"))
})
