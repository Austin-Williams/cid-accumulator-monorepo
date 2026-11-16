import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { defaultAccumulatorContractAddress, defaultLightClientConfig } from "../source/config/defaultConfig.js"
import { createLightClient } from "../source/core/lightClient/createLightClient.js"
import { createSeeder } from "../source/core/seeder/createSeeder.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import { mergeConfigWithDefaults } from "../source/utils/mergeConfigs.js"

describe("configuration merging", () => {
	test("preserves an address instance while merging the surrounding configuration", () => {
		const address = new EthereumAddress("0x" + "AB".repeat(20))
		const merged = mergeConfigWithDefaults(
			{ accumulatorContractConfig: { accumulatorContractAddress: address, rateLimiterOptions: { maxRetries: 2 } } },
			defaultLightClientConfig
		)
		assert.equal(merged.accumulatorContractConfig.accumulatorContractAddress, address)
		assert.equal(merged.accumulatorContractConfig.accumulatorContractAddress.toString(), "0x" + "ab".repeat(20))
		assert.deepEqual(merged.accumulatorContractConfig.rateLimiterOptions, {
			...defaultLightClientConfig.accumulatorContractConfig.rateLimiterOptions,
			maxRetries: 2,
		})
		assert.equal(
			merged.accumulatorContractConfig.ethereumHttpRpcUrl,
			defaultLightClientConfig.accumulatorContractConfig.ethereumHttpRpcUrl
		)
		assert.equal(
			defaultLightClientConfig.accumulatorContractConfig.accumulatorContractAddress,
			defaultAccumulatorContractAddress
		)
	})

	test("nested partial settings retain defaults without modifying either input", () => {
		const defaults: { settings: { retries: number; backoff: { base: number; cap: number } }; enabled: boolean } =
			Object.freeze({
				settings: Object.freeze({ retries: 3, backoff: Object.freeze({ base: 100, cap: 1000 }) }),
				enabled: true,
			})
		const overrides = Object.freeze({
			settings: Object.freeze({ retries: undefined, backoff: Object.freeze({ base: 50 }) }),
			enabled: false,
		})
		const merged = mergeConfigWithDefaults(overrides, defaults)
		assert.deepEqual(merged, { settings: { retries: 3, backoff: { base: 50, cap: 1000 } }, enabled: false })
		assert.equal(defaults.settings.backoff.base, 100)
		assert.equal(overrides.settings.backoff.base, 50)
	})

	test("arrays replace defaults as complete values and retain address instances", () => {
		const defaults = { accounts: [new EthereumAddress("0x" + "11".repeat(20))] }
		const accounts = [new EthereumAddress("0x" + "22".repeat(20))]
		assert.equal(mergeConfigWithDefaults({ accounts }, defaults).accounts, accounts)
		assert.equal(defaults.accounts[0].toString(), "0x" + "11".repeat(20))
		assert.deepEqual(mergeConfigWithDefaults({ accounts: [] }, defaults).accounts, [])
	})

	test("a class instance and a plain object replace each other instead of merging", () => {
		const instance = new EthereumAddress("0x" + "33".repeat(20))
		const record = { label: "replacement" }
		assert.equal(mergeConfigWithDefaults<{ value: object }>({ value: instance }, { value: record }).value, instance)
		assert.equal(mergeConfigWithDefaults<{ value: object }>({ value: record }, { value: instance }).value, record)
	})

	test("null values are replaced rather than treated as configuration objects", () => {
		const value = { enabled: true }
		assert.equal(mergeConfigWithDefaults<{ value: object | null }>({ value }, { value: null }).value, value)
		assert.equal(mergeConfigWithDefaults<{ value: object | null }>({ value: null }, { value }).value, null)
	})

	test("plain objects with a null prototype still merge nested defaults", () => {
		const defaults = { settings: Object.assign(Object.create(null), { retries: 3, delay: 100 }) }
		const overrides = { settings: Object.assign(Object.create(null), { retries: 1 }) }
		assert.deepEqual(mergeConfigWithDefaults(overrides, defaults), { settings: { retries: 1, delay: 100 } })
	})
})

describe("factory address configuration", { concurrency: false, timeout: 5000 }, () => {
	for (const factory of ["light client", "seeder"] as const) {
		for (const addressFormat of ["instance", "string", "default"] as const) {
			test(`${factory} sends contract calls to the configured ${addressFormat} address`, async (t) => {
				t.mock.method(console, "log", () => {})
				const fetch = t.mock.method(globalThis, "fetch", async () =>
					Response.json({ jsonrpc: "2.0", id: 1, result: "0x7b" })
				)
				const address = new EthereumAddress("0x" + "AB".repeat(20))
				const account = new EthereumAddress("0x" + "CD".repeat(20))
				const ethereumHttpRpcUrl = "https://ethereum.example.test"
				const config = {
					accumulatorContractConfig: {
						accumulatorContractAddress:
							addressFormat === "instance" ? address : addressFormat === "string" ? "0x" + "AB".repeat(20) : undefined,
						ethereumHttpRpcUrl,
						rateLimiterOptions: { intervalMs: 0 },
					},
				}
				// Leave services and storage unopened; exercise only contract calls through the mock RPC.
				const contract =
					factory === "light client"
						? (await createLightClient(account, config)).accumulatorContract
						: (await createSeeder(config)).dependencies.accumulatorContract
				t.after(() => contract.stop())
				assert.equal(fetch.mock.callCount(), 0)
				assert.equal(await contract.getSingletonBirthdayBlockNum(), 123)
				assert.equal(fetch.mock.callCount(), 1)
				const [url, init] = fetch.mock.calls[0].arguments
				assert.equal(url, ethereumHttpRpcUrl)
				const request = JSON.parse(String(init?.body))
				assert.equal(request.method, "eth_call")
				assert.equal(
					request.params[0].to,
					(addressFormat === "default" ? defaultAccumulatorContractAddress : address).toString()
				)
			})
		}
	}
})
