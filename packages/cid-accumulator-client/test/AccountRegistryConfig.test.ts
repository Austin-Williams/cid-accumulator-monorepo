import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import {
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientAccountRegistryServiceConfig,
	defaultSeederAccountRegistryServiceConfig,
} from "../source/config/defaultConfig.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import { AccountRegistryService } from "../source/services/AccountRegistryService.js"
import type { AccountRegistryServiceConfig } from "../source/services/AccountRegistryService.types.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"

function fixture(t: TestContext) {
	t.mock.method(console, "log", () => {})
	const account = new EthereumAddress("0x" + "11".repeat(20))
	const contract = new AccumulatorContract(defaultLightClientAccumulatorContractConfig)
	t.mock.method(contract, "getSingletonBirthdayBlockNum", async () => 1)
	t.mock.method(contract, "getBlockNumber", async () => 2)
	const getLogs = t.mock.method(contract, "getNewAccountInitializedLogs", async () => [{ account, blockNumber: 2 }])
	const registries: AccountRegistryService[] = []
	function create(config: Required<AccountRegistryServiceConfig>, storage = new InMemoryAdapter()) {
		const registry = new AccountRegistryService(storage, contract, config)
		registries.push(registry)
		return registry
	}
	t.after(() => {
		for (const registry of registries) registry.stop()
		contract.stop()
	})
	async function discover(registry: AccountRegistryService) {
		const discovered = new Promise<EthereumAddress>((resolve) => {
			registry.subscribe((address) => {
				// Stop before the polling loop schedules its next timer.
				registry.stop()
				resolve(address)
			})
		})
		await registry.start()
		assert.equal(await discovered, account)
	}
	return { account, create, discover, getLogs }
}

describe("account registry configuration isolation", { concurrency: false, timeout: 5000 }, () => {
	for (const [name, config] of [
		["light-client", defaultLightClientAccountRegistryServiceConfig],
		["seeder", defaultSeederAccountRegistryServiceConfig],
	] as const) {
		test(`${name} defaults stay unrestricted after another registry discovers an account`, async (t) => {
			const f = fixture(t)
			const originalAccounts = [...config.specificAccountsOnly]
			t.after(() => config.specificAccountsOnly.splice(0, config.specificAccountsOnly.length, ...originalAccounts))
			const first = f.create(config)
			await f.discover(first)
			assert.deepEqual(first.knownAccounts, [f.account])
			assert.equal(config.specificAccountsOnly.length, 0)

			const second = f.create(config)
			assert.equal(second.specificAccountsMode, false)
			assert.equal(second.knownAccounts.length, 0)
			await f.discover(second)
			assert.equal(f.getLogs.mock.callCount(), 2, "Each unrestricted registry must discover accounts independently")
		})
	}

	test("loading cached accounts does not restrict another registry using the same configuration", async (t) => {
		const f = fixture(t)
		const config = { ...defaultSeederAccountRegistryServiceConfig, specificAccountsOnly: [] as EthereumAddress[] }
		const storage = new InMemoryAdapter()
		await storage.put("account-registry:account:0", f.account.toString())
		const first = f.create(config, storage)
		await first.init()
		assert.deepEqual(first.knownAccounts.map(String), [f.account.toString()])
		assert.equal(config.specificAccountsOnly.length, 0)

		const second = f.create(config)
		assert.equal(second.specificAccountsMode, false)
		assert.equal(second.knownAccounts.length, 0)
		await f.discover(second)
	})

	test("configured accounts remain restricted and isolated from later array mutations", async (t) => {
		const f = fixture(t)
		const configured = [f.account]
		const registry = f.create({ ...defaultSeederAccountRegistryServiceConfig, specificAccountsOnly: configured })
		const another = new EthereumAddress("0x" + "22".repeat(20))
		configured.splice(0, 1, another)
		assert.equal(registry.specificAccountsMode, true)
		assert.equal(registry.knownAccounts.length, 1)
		assert.equal(registry.knownAccounts[0], f.account, "Copy the list while preserving address instances")
		const notifications: EthereumAddress[] = []
		registry.subscribe((account) => notifications.push(account))
		await registry.start()
		assert.deepEqual(notifications, [f.account])
		assert.equal(f.getLogs.mock.callCount(), 0)
		registry.knownAccounts.push(another)
		assert.deepEqual(configured, [another])
	})
})
