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
import { mergeConfigWithDefaults } from "../source/utils/mergeConfigs.js"

const execFileAsync = promisify(execFile)
const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const runner = new URL("../scripts/runSeeder.ts", import.meta.url)
const seederModule = new URL("../source/core/seeder/Seeder.ts", import.meta.url)
const factoryModule = new URL("../source/core/seeder/createSeeder.ts", import.meta.url)

async function runCli(args: string[], writeStorage = false): Promise<SeederConfig> {
	// Exercise the actual entry point, stopping before networking, polling, or signal handlers start.
	const marker = "TEST_CLI_CONFIG\n"
	const bootstrap = `
import { mock } from "node:test"
import { Seeder } from ${JSON.stringify(seederModule.href)}
import { createSeeder } from ${JSON.stringify(factoryModule.href)}
mock.module(${JSON.stringify(factoryModule.href)}, {
	namedExports: {
		createSeeder: async (config) => {
			const seeder = await createSeeder(config)
			console.log(${JSON.stringify(marker)} + JSON.stringify(config))
			return seeder
		},
	},
})
const stoppedBeforeStartup = new Error("Stop before starting seeder services")
Seeder.prototype.start = async function () {
	this.dependencies.accumulatorContract.getChainId = async () => 1n
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
		["--import", "tsx", "--experimental-test-module-mocks", "--input-type=module", "--eval", bootstrap, "--", "--accumulatorContractAddress=0x" + "ab".repeat(20), ...args],
		{ cwd: packageDirectory, env, timeout: 10000 }
	)
	const offset = stdout.indexOf(marker)
	assert.notEqual(offset, -1, "The runner must pass its configuration to the seeder factory")
	const config = JSON.parse(stdout.slice(offset + marker.length))
	return mergeConfigWithDefaults(config, {
		...defaultSeederConfig,
		accumulatorContractConfig: {
			...defaultSeederConfig.accumulatorContractConfig,
			accumulatorContractAddress: config.accumulatorContractConfig.accumulatorContractAddress,
		},
	})
}

describe("seeder CLI configuration", () => {
	for (const format of ["inline", "separate"] as const) {
		test(`${format} arguments preserve database paths and URL query values through seeder creation`, async (t) => {
			const directory = await mkdtemp(join(tmpdir(), "seeder-cli-"))
			t.after(() => rm(directory, { recursive: true, force: true }))
			const nodeDbPath = join(directory, "cache = primary.json")
			const contractAddress = "0x" + "ab".repeat(20)
			const ethereumHttpRpcUrl = "https://rpc.example.test/?token=abc==&network=mainnet"
			const ipfsGatewayUrl = "https://gateway.example.test/?token=def==&mode=car"
			const ipfsPinnerBaseUrl = "https://pinner.example.test/api/v0?token=ghi==&pin=true"
			const options = {
				nodeDbPath,
				ethereumHttpRpcUrl,
				ipfsGatewayUrl,
				ipfsPinnerBaseUrl,
				accumulatorContractAddress: contractAddress,
				remotePin: "true",
			}
			const args = Object.entries(options).flatMap(([key, value]) =>
				format === "inline" ? [`--${key}=${value}`] : [`--${key}`, value]
			)
			// Verify the selected path before the test writes anything to storage.
			const config = await runCli(args)
			assert.equal(config.nodeDbPath, nodeDbPath)
			assert.equal(config.accumulatorContractConfig.ethereumHttpRpcUrl, ethereumHttpRpcUrl)
			assert.equal(config.ipfsResolverConfig.gatewayUrl, ipfsGatewayUrl)
			assert.equal(config.ipfsPinnerConfig.baseUrl, ipfsPinnerBaseUrl)
			assert.equal(config.accumulatorContractConfig.accumulatorContractAddress, contractAddress)
			assert.equal(config.ipfsPinnerConfig.remotePin, true)
			assert.deepEqual(
				config.accumulatorContractConfig.rateLimiterOptions,
				defaultSeederConfig.accumulatorContractConfig.rateLimiterOptions
			)

			await runCli(args, true)
			const saved = JSON.parse(await readFile(nodeDbPath, "utf8"))
			assert.deepEqual(Object.values(saved), ["stored"])
			assert.ok(Object.keys(saved)[0].endsWith("cli:test"))
		})
	}

	test("omitted options keep the default database path and URLs", async () => {
		const config = await runCli([])
		assert.equal(config.nodeDbPath, defaultSeederConfig.nodeDbPath)
		assert.equal(config.browserDbName, "cid-accumulator")
		assert.equal(
			config.accumulatorContractConfig.ethereumHttpRpcUrl,
			defaultSeederConfig.accumulatorContractConfig.ethereumHttpRpcUrl
		)
		assert.equal(config.ipfsResolverConfig.gatewayUrl, defaultSeederConfig.ipfsResolverConfig.gatewayUrl)
		assert.equal(config.ipfsPinnerConfig.baseUrl, defaultSeederConfig.ipfsPinnerConfig.baseUrl)
	})

	test("mixed argument formats retain the last repeated option and following flags", async () => {
		const config = await runCli([
			"--nodeDbPath=first.json",
			"--nodeDbPath",
			"second = cache.json",
			"--ethereumHttpRpcUrl",
			"https://first.example.test/?token=first==",
			"--ethereumHttpRpcUrl=https://second.example.test/?token=second==",
			"--remotePin=false",
		])
		assert.equal(config.nodeDbPath, "second = cache.json")
		assert.equal(config.accumulatorContractConfig.ethereumHttpRpcUrl, "https://second.example.test/?token=second==")
		assert.equal(config.ipfsPinnerConfig.remotePin, false)
	})

	test("an empty inline value does not consume the following flag", async () => {
		const config = await runCli(["--ethereumHttpRpcUrl=", "--nodeDbPath=cache.json", "--remotePin=true"])
		assert.equal(
			config.accumulatorContractConfig.ethereumHttpRpcUrl,
			defaultSeederConfig.accumulatorContractConfig.ethereumHttpRpcUrl
		)
		assert.equal(config.nodeDbPath, "cache.json")
		assert.equal(config.ipfsPinnerConfig.remotePin, true)
	})
})
