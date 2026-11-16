import { mockChain } from "./mockChain.js"
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import { setImmediate } from "node:timers/promises"
import {
	defaultIpfsPinnerConfig,
	defaultLightClientAccumulatorContractConfig,
	defaultLightClientEventCacheServiceConfig,
	defaultLightClientIpfsResolverConfig,
	defaultSeederAccountRegistryServiceConfig,
} from "../source/config/defaultConfig.js"
import { AccumulatorContract } from "../source/ethereum/AccumulatorContract.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import { IpfsPinner } from "../source/ipfs/IpfsPinner.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import type { CIDDataPair } from "../source/ipfs/types.js"
import { MerkleMountainRange } from "../source/mmr/MerkleMountainRange.js"
import { AccountRegistryService } from "../source/services/AccountRegistryService.js"
import { DataClientManager } from "../source/services/DataClientManager.js"
import { EventCacheService } from "../source/services/EventCacheService.js"
import { PinningService } from "../source/services/PinningService.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { putLeafRecordInDB } from "../source/storage/utils.js"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

async function fixture(t: TestContext, pause: "sync" | "pin") {
	t.mock.method(console, "log", () => {})
	t.mock.method(console, "warn", () => {})
	t.mock.method(console, "error", () => {})
	const intervals = t.mock.method(globalThis, "setInterval")
	const storage = new InMemoryAdapter()
	const first = new EthereumAddress("0x" + "11".repeat(20))
	const second = new EthereumAddress("0x" + "22".repeat(20))
	const contract = new AccumulatorContract({ ...defaultLightClientAccumulatorContractConfig, accumulatorContractAddress: "0x" + "ab".repeat(20) })
	mockChain(t, contract, storage)
	const registry = new AccountRegistryService(storage, contract, {
		...defaultSeederAccountRegistryServiceConfig,
		specificAccountsOnly: [first],
	})
	// Control discovery timing without running the registry's independent polling loop.
	const listeners = new Set<(account: EthereumAddress) => void>()
	const registrySubscriptions = t.mock.method(registry, "subscribe", (callback: (account: EthereumAddress) => void) => {
		listeners.add(callback)
		return () => {
			listeners.delete(callback)
		}
	})
	const events = new EventCacheService(storage, contract, defaultLightClientEventCacheServiceConfig)
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	const manager = new DataClientManager(storage, contract, registry, events, resolver)
	const firstClient = manager.getOrCreateDataClient(first)
	const secondClient = manager.getOrCreateDataClient(second)
	firstClient.completedInitialSync = pause !== "sync"
	secondClient.completedInitialSync = true
	const firstSubscriptions = t.mock.method(firstClient, "subscribe")
	const secondSubscriptions = t.mock.method(secondClient, "subscribe")
	const entered = deferred()
	const release = deferred()
	if (pause === "sync")
		t.mock.method(firstClient, "sync", async () => {
			entered.resolve()
			await release.promise
			firstClient.completedInitialSync = true
		})
	const chains = new Map<string, MerkleMountainRange>()
	const expectedPins = new Map<string, Set<string>>()
	for (const [address, payloads] of [
		[first, [1]],
		[second, [2, 3]],
	] as const) {
		const chain = new MerkleMountainRange()
		const expected = new Set<string>()
		for (const [leafIndex, value] of payloads.entries()) {
			const payload = Uint8Array.of(value)
			for (const pair of await chain.addLeafWithTrail(leafIndex, payload)) expected.add(pair.cid.toString())
			await putLeafRecordInDB(storage, address, leafIndex, { account: address, leafIndex, payload })
		}
		chains.set(address.toString(), chain)
		expectedPins.set(address.toString(), expected)
	}
	t.mock.method(contract, "getRootCID", (address: EthereumAddress) => chains.get(address.toString())!.rootCID())
	const pinner = new IpfsPinner(storage, defaultIpfsPinnerConfig)
	t.mock.method(pinner, "init", async () => {})
	const pinned = new Map<string, Set<string>>()
	t.mock.method(pinner, "putAndPin", async (pair: CIDDataPair, address: EthereumAddress) => {
		if (pause === "pin" && address.toString() === first.toString()) {
			entered.resolve()
			await release.promise
		}
		const pins = pinned.get(address.toString()) ?? new Set<string>()
		pins.add(pair.cid.toString())
		pinned.set(address.toString(), pins)
	})
	const service = new PinningService(storage, contract, registry, manager, pinner, 60000)
	t.after(() => {
		release.resolve()
		service.stop()
		contract.stop()
		events.stop()
		resolver.stop()
	})
	function discover(address: EthereumAddress) {
		if (!registry.knownAccounts.some((known) => known.toString() === address.toString()))
			registry.knownAccounts.push(address)
		for (const listener of listeners) listener(address)
	}
	async function assertPinned(address: EthereumAddress) {
		const chain = chains.get(address.toString())!
		const deadline = Date.now() + 1000
		while (service.mmrs.get(address.toString())?.leafCount !== chain.leafCount) {
			assert.ok(Date.now() < deadline, "Timed out waiting for discovered account pinning")
			await setImmediate()
		}
		assert.deepEqual(pinned.get(address.toString()), expectedPins.get(address.toString()))
		assert.equal((await service.mmrs.get(address.toString())!.rootCID()).toString(), (await chain.rootCID()).toString())
	}
	return {
		service,
		first,
		second,
		entered,
		release,
		discover,
		assertPinned,
		pinned,
		listeners,
		registrySubscriptions,
		firstSubscriptions,
		secondSubscriptions,
		intervals,
	}
}

describe("account discovery during pinning startup", { concurrency: false, timeout: 5000 }, () => {
	for (const pause of ["sync", "pin"] as const) {
		test(`a new account is pinned while the first account's ${pause} is pending, without duplicate subscriptions`, async (t) => {
			const f = await fixture(t, pause)
			const starting = f.service.start()
			try {
				await f.entered.promise
				f.discover(f.second)
				assert.ok(f.service.mmrs.has(f.second.toString()), "Discovery must be observed before initial work finishes")
				f.discover(new EthereumAddress(f.second.toString()))
				f.discover(new EthereumAddress(f.first.toString()))
				await f.service.start()
				await f.assertPinned(f.second)
				assert.equal(f.registrySubscriptions.mock.callCount(), 1)
				assert.equal(f.firstSubscriptions.mock.callCount(), 1)
				assert.equal(f.secondSubscriptions.mock.callCount(), 1)
			} finally {
				f.release.resolve()
				await starting
			}
			await f.assertPinned(f.first)
			await f.service.start()
			assert.equal(f.registrySubscriptions.mock.callCount(), 1)
			assert.equal(f.secondSubscriptions.mock.callCount(), 1)
		})
	}

	test("stop during initial sync removes the discovery subscription and prevents later tracking", async (t) => {
		const f = await fixture(t, "sync")
		const starting = f.service.start()
		try {
			await f.entered.promise
			assert.equal(f.listeners.size, 1)
			f.service.stop()
			assert.equal(f.listeners.size, 0)
			f.discover(f.second)
			assert.equal(f.service.mmrs.size, 0)
			assert.equal(f.secondSubscriptions.mock.callCount(), 0)
		} finally {
			f.release.resolve()
			await starting
		}
		assert.equal(f.service.mmrs.size, 0)
		assert.equal(f.pinned.size, 0)
		assert.equal(f.intervals.mock.callCount(), 0)
	})
})
