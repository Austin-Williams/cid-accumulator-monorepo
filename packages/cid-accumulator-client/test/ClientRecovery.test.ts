import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import {
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
	defaultLightClientIpfsResolverConfig,
} from "../source/config/defaultConfig.js"
import { LightClient } from "../source/core/lightClient/LightClient.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { JSMapAdapter } from "../source/storage/adapters/JSMapAdapter.js"
import type { Storage } from "../source/storage/interface.js"
import type { LifecycleComponent } from "../source/types/common.js"

type State = Awaited<ReturnType<AccumulatorContract["getState"]>>

function emptyState(): State {
	return {
		meta: { leafCount: 0, peakCount: 0, peakHeights: [], previousInsertBlockNumber: 0, deployBlockNumber: 0 },
		peaks: [],
	}
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((done, fail) => {
		resolve = done
		reject = fail
	})
	return { promise, resolve, reject }
}

function fixture(t: TestContext, storage: Storage = new InMemoryAdapter()) {
	t.mock.method(console, "log", () => {})
	t.mock.method(console, "warn", () => {})
	t.mock.method(console, "error", () => {})
	const account = new EthereumAddress("0x" + "11".repeat(20))
	const contract = new AccumulatorContract({ ...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: "0x" + "ab".repeat(20) })
	mockChain(t, contract, storage)
	const eventCache = new EventCacheService(storage, contract, defaultLightClientEventCacheServiceConfig)
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	let stateProvider: () => Promise<State> = async () => emptyState()
	const getState = t.mock.method(contract, "getState", () => stateProvider())
	const getBirthday = t.mock.method(contract, "getSingletonBirthdayBlockNum", async () => 1)
	const getBlock = t.mock.method(contract, "getBlockNumber", async () => 1)
	const client = new LightClient(account, {
		storage,
		accumulatorContract: contract,
		eventCacheService: eventCache,
		ipfsResolver: resolver,
	})
	const stops: string[] = []
	const components: Array<[string, LifecycleComponent]> = [
		["storage", storage],
		["contract", contract],
		["events", eventCache],
		["resolver", resolver],
	]
	for (const [name, component] of components) {
		const stop = component.stop.bind(component)
		t.mock.method(component, "stop", () => {
			stops.push(name)
			stop()
		})
	}
	t.after(() => {
		// Also release the old polling loop if a regression leaves a sync waiting forever.
		client.syncing = false
		eventCache.stop()
		resolver.stop()
		contract.stop()
	})
	return {
		client,
		storage,
		contract,
		eventCache,
		resolver,
		getState,
		getBirthday,
		getBlock,
		stops,
		setStateProvider: (provider: () => Promise<State>) => {
			stateProvider = provider
		},
	}
}

describe("client failure recovery", { concurrency: false, timeout: 5000 }, () => {
	test("a failed sync releases its state and can be retried", async (t) => {
		const { client, getState, setStateProvider } = fixture(t)
		const error = new Error("RPC unavailable")
		setStateProvider(async () => {
			throw error
		})
		await assert.rejects(client.sync(), (caught) => caught === error)
		assert.equal(client.syncing, false)
		assert.equal(client.completedInitialSync, false)

		setStateProvider(async () => emptyState())
		await client.sync()
		assert.equal(getState.mock.callCount(), 2)
		assert.equal(client.syncing, false)
		assert.equal(client.completedInitialSync, true)
	})

	for (const outcome of ["success", "failure"] as const) {
		test(`concurrent sync callers share one RPC request and its ${outcome}`, { timeout: 1000 }, async (t) => {
			const { client, getState, setStateProvider } = fixture(t)
			const response = deferred<State>()
			const error = new Error("RPC unavailable")
			setStateProvider(() => response.promise)
			const results = Promise.allSettled([client.sync(), client.sync(), client.sync()])
			assert.equal(client.syncing, true)
			if (outcome === "success") response.resolve(emptyState())
			else response.reject(error)
			for (const result of await results) {
				assert.equal(result.status, outcome === "success" ? "fulfilled" : "rejected")
				if (result.status === "rejected") assert.equal(result.reason, error)
			}
			assert.equal(getState.mock.callCount(), 1)
			assert.equal(client.syncing, false)
			assert.equal(client.completedInitialSync, outcome === "success")

			setStateProvider(async () => emptyState())
			await client.sync()
			assert.equal(getState.mock.callCount(), 2)
		})
	}

	test("failed initialization cleans up only initialized services and allows retry", async (t) => {
		const { client, getBirthday, stops } = fixture(t)
		const error = new Error("Could not read the deployment block")
		getBirthday.mock.mockImplementationOnce(async () => {
			throw error
		})
		await assert.rejects(client.start(), (caught) => caught === error)
		assert.deepEqual(stops, ["contract", "storage"])
		assert.equal(client.running, false)
		assert.equal(client.initialized, false)

		await client.start()
		assert.equal(getBirthday.mock.callCount(), 2)
		assert.equal(client.running, true)
		assert.equal(client.completedInitialSync, true)
	})

	test("failure while starting polling rolls back and retries the services", async (t) => {
		const { client, getBlock, stops } = fixture(t)
		const error = new Error("Could not read the latest block")
		getBlock.mock.mockImplementationOnce(async () => {
			throw error
		})
		await assert.rejects(client.start(), (caught) => caught === error)
		assert.deepEqual(stops, ["resolver", "events", "contract", "storage"])
		assert.equal(client.running, false)
		assert.equal(client.initialized, false)

		await client.start()
		assert.ok(getBlock.mock.callCount() >= 2)
		assert.equal(client.running, true)
		assert.equal(client.completedInitialSync, true)
	})

	test("concurrent starts share sync failure, stop polling, and can start again", async (t) => {
		const { client, getState, getBlock, setStateProvider, stops } = fixture(t)
		const setInterval = t.mock.method(globalThis, "setInterval")
		const clearInterval = t.mock.method(globalThis, "clearInterval")
		const error = new Error("Initial sync failed")
		setStateProvider(async () => {
			throw error
		})
		for (const result of await Promise.allSettled([client.start(), client.start()])) {
			assert.equal(result.status, "rejected")
			if (result.status === "rejected") assert.equal(result.reason, error)
		}
		assert.equal(getState.mock.callCount(), 1)
		assert.equal(setInterval.mock.callCount(), 1)
		assert.equal(clearInterval.mock.calls[0].arguments[0], setInterval.mock.calls[0].result)
		assert.deepEqual(stops, ["resolver", "events", "contract", "storage"])
		assert.equal(client.running, false)
		assert.equal(client.initialized, false)
		assert.equal(client.syncing, false)
		assert.equal(client.completedInitialSync, false)

		setStateProvider(async () => emptyState())
		await client.start()
		assert.equal(getState.mock.callCount(), 2)
		assert.ok(getBlock.mock.callCount() >= 2)
		assert.equal(client.running, true)
		assert.equal(client.initialized, true)
		assert.equal(client.completedInitialSync, true)
		client.stop()
		assert.equal(client.running, false)
		assert.equal(client.initialized, false)
	})

	test("cleanup errors do not hide the original startup error or prevent other cleanup", async (t) => {
		const { client, resolver, setStateProvider, stops } = fixture(t)
		const error = new Error("Initial sync failed")
		setStateProvider(async () => {
			throw error
		})
		const stop = resolver.stop.bind(resolver)
		t.mock.method(
			resolver,
			"stop",
			() => {
				stop()
				throw new Error("Cleanup failed")
			},
			{ times: 1 }
		)
		await assert.rejects(client.start(), (caught) => caught === error)
		assert.deepEqual(stops, ["resolver", "events", "contract", "storage"])
		assert.equal(client.running, false)
		assert.equal(client.initialized, false)

		setStateProvider(async () => emptyState())
		await client.start()
		assert.equal(client.completedInitialSync, true)
	})

	test("failed database opening cannot overwrite the file during startup cleanup", async (t) => {
		const directory = await fs.mkdtemp(join(tmpdir(), "cid-recovery-test-"))
		t.after(() => fs.rm(directory, { recursive: true, force: true }))
		const filePath = join(directory, "database.json")
		await fs.writeFile(filePath, "invalid JSON", "utf8")
		const storage = new JSMapAdapter(filePath)
		const { client, stops } = fixture(t, storage)
		await assert.rejects(client.start(), SyntaxError)
		assert.deepEqual(stops, [])
		assert.equal(client.running, false)
		assert.equal(client.initialized, false)
		assert.equal(await fs.readFile(filePath, "utf8"), "invalid JSON")

		await fs.writeFile(filePath, "{}", "utf8")
		await client.start()
		assert.equal(client.completedInitialSync, true)
		await storage.close()
	})
})
