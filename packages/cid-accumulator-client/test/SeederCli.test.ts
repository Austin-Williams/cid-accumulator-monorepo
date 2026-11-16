import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { defaultSeederConfig } from "../source/config/defaultConfig.js"
import type { SeederConfig } from "../source/core/seeder/Seeder.types.js"

const execFileAsync = promisify(execFile)
const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const runner = new URL("../scripts/runSeeder.ts", import.meta.url)
const seederModule = new URL("../source/core/seeder/Seeder.ts", import.meta.url)

async function runCli(args: string[], writeStorage = false): Promise<SeederConfig> {
	// Exercise the actual entry point, stopping before networking, polling, or signal handlers start.
	const bootstrap = `
import { Seeder } from ${JSON.stringify(seederModule.href)}
const stoppedBeforeStartup = new Error("Stop before starting seeder services")
Seeder.prototype.start = async function () {
	${writeStorage ? 'await this.dependencies.storage.put("cli:test", "stored")' : ""}
	throw stoppedBeforeStartup
}
process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(runner))}, ...process.argv.slice(1)]
try {
	await import(${JSON.stringify(runner.href)})
	throw new Error("Expected the runner to start the seeder")
} catch (error) {
	if (error !== stoppedBeforeStartup) throw error
}
`
	const env = { ...process.env }
	delete env.NODE_OPTIONS
	delete env.NODE_PATH
	const { stdout } = await execFileAsync(
		process.execPath,
		["--import", "tsx", "--input-type=module", "--eval", bootstrap, "--", ...args],
		{ cwd: packageDirectory, env, timeout: 10000 }
	)
	const marker = "==== Seeder Configuration ====\n"
	const offset = stdout.indexOf(marker)
	assert.notEqual(offset, -1, "The runner must create the seeder and report its merged configuration")
	return JSON.parse(stdout.slice(offset + marker.length))
}

describe("seeder CLI configuration", () => {
	for (const format of ["inline", "separate"] as const) {
		test(`${format} arguments preserve database paths and URL query values through seeder creation`, async (t) => {
			const directory = await mkdtemp(join(tmpdir(), "seeder-cli-"))
			t.after(() => rm(directory, { recursive: true, force: true }))
			const dbPath = join(directory, "cache = primary.json")
			const contractAddress = "0x" + "ab".repeat(20)
			const ethereumHttpRpcUrl = "https://rpc.example.test/?token=abc==&network=mainnet"
			const ipfsGatewayUrl = "https://gateway.example.test/?token=def==&mode=car"
			const ipfsPinnerBaseUrl = "https://pinner.example.test/api/v0?token=ghi==&pin=true"
			const options = {
				dbPath,
				ethereumHttpRpcUrl,
				ipfsGatewayUrl,
				ipfsPinnerBaseUrl,
				accumulatorContractAddress: contractAddress,
				remotePin: "true",
				specificAccountsOnly: "[]",
			}
			const args = Object.entries(options).flatMap(([key, value]) =>
				format === "inline" ? [`--${key}=${value}`] : [`--${key}`, value]
			)
			// A missing dbPath must fail before the test writes anything to the default database.
			const config = await runCli(args)
			assert.equal(config.dbPath, dbPath)
			assert.equal(config.accumulatorContractConfig.ethereumHttpRpcUrl, ethereumHttpRpcUrl)
			assert.equal(config.ipfsResolverConfig.gatewayUrl, ipfsGatewayUrl)
			assert.equal(config.ipfsPinnerConfig.baseUrl, ipfsPinnerBaseUrl)
			assert.equal(config.accumulatorContractConfig.accumulatorContractAddress, contractAddress)
			assert.equal(config.ipfsPinnerConfig.remotePin, true)
			assert.deepEqual(config.accountRegistryServiceConfig.specificAccountsOnly, [])
			assert.deepEqual(config.eventCacheServiceConfig.specificAccountsOnly, [])
			assert.deepEqual(
				config.accumulatorContractConfig.rateLimiterOptions,
				defaultSeederConfig.accumulatorContractConfig.rateLimiterOptions
			)

			await runCli(args, true)
			assert.deepEqual(JSON.parse(await readFile(`${dbPath}-${contractAddress}`, "utf8")), { "cli:test": "stored" })
		})
	}

	test("omitted options keep the default database path and URLs", async () => {
		const config = await runCli([])
		assert.equal(config.dbPath, defaultSeederConfig.dbPath)
		assert.equal(
			config.accumulatorContractConfig.ethereumHttpRpcUrl,
			defaultSeederConfig.accumulatorContractConfig.ethereumHttpRpcUrl
		)
		assert.equal(config.ipfsResolverConfig.gatewayUrl, defaultSeederConfig.ipfsResolverConfig.gatewayUrl)
		assert.equal(config.ipfsPinnerConfig.baseUrl, defaultSeederConfig.ipfsPinnerConfig.baseUrl)
	})

	test("mixed argument formats retain the last repeated option and following flags", async () => {
		const config = await runCli([
			"--dbPath=first.json",
			"--dbPath",
			"second = cache.json",
			"--ethereumHttpRpcUrl",
			"https://first.example.test/?token=first==",
			"--ethereumHttpRpcUrl=https://second.example.test/?token=second==",
			"--remotePin=false",
		])
		assert.equal(config.dbPath, "second = cache.json")
		assert.equal(config.accumulatorContractConfig.ethereumHttpRpcUrl, "https://second.example.test/?token=second==")
		assert.equal(config.ipfsPinnerConfig.remotePin, false)
	})

	test("an empty inline value does not consume the following flag", async () => {
		const config = await runCli(["--ethereumHttpRpcUrl=", "--dbPath=cache.json", "--remotePin=true"])
		assert.equal(
			config.accumulatorContractConfig.ethereumHttpRpcUrl,
			defaultSeederConfig.accumulatorContractConfig.ethereumHttpRpcUrl
		)
		assert.equal(config.dbPath, "cache.json")
		assert.equal(config.ipfsPinnerConfig.remotePin, true)
	})
})
