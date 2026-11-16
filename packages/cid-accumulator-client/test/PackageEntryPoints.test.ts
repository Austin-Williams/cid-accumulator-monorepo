import { execFile } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const packageDirectory = fileURLToPath(new URL("../", import.meta.url))

const entryPoints = [
	{
		mode: "module",
		load: `import assert from "node:assert/strict"
import * as client from "cid-accumulator-client"`,
	},
	{
		mode: "commonjs",
		load: `const assert = require("node:assert/strict")
const client = require("cid-accumulator-client")`,
	},
]

for (const { mode, load } of entryPoints) {
	test(`the built package loads in plain Node using ${mode}`, async () => {
		// Start a fresh process without the test runner's tsx loader or inherited loaders.
		const env = { ...process.env }
		delete env.NODE_OPTIONS
		delete env.NODE_PATH
		await execFileAsync(process.execPath, ["--input-type=" + mode, "--eval", `${load}
assert.equal(typeof client.createLightClient, "function")
assert.equal(typeof client.createSeeder, "function")
assert.equal(typeof client.DataClient, "function")
assert.equal(client.uint8ArrayToHexString(Uint8Array.of(0, 255)), "00ff")
assert.equal(new client.EthereumAddress("0x" + "AB".repeat(20)).toString(), "0x" + "ab".repeat(20))
`], { cwd: packageDirectory, env, timeout: 10000 })
	})
}
