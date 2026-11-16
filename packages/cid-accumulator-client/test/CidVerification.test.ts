import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import { defaultIpfsPinnerConfig, defaultLightClientIpfsResolverConfig } from "../source/config/defaultConfig.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import { IpfsPinner } from "../source/ipfs/IpfsPinner.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { encodeBlock, uint8ArrayToHexString } from "../source/utils/codec.js"

async function fixture(t: TestContext, remotePin = false) {
	const block = await encodeBlock(Uint8Array.of(1))
	const differentBlock = await encodeBlock(Uint8Array.of(2))
	const storage = new InMemoryAdapter()
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	const pinner = new IpfsPinner(storage, {
		...defaultIpfsPinnerConfig,
		baseUrl: "https://ipfs.example.test/api/v0",
		remotePin,
	})
	// Even a server claiming the expected CID must not bypass validation before upload.
	const fetch = t.mock.method(globalThis, "fetch", async () =>
		Response.json({ Key: block.cid.toString(), RemoteServices: [] })
	)
	t.after(() => {
		resolver.stop()
		pinner.stop()
	})
	return {
		block,
		differentBlock,
		storage,
		resolver,
		pinner,
		fetch,
		key: `ipfs:block:${block.cid}`,
		account: new EthereumAddress("0x" + "11".repeat(20)),
	}
}

describe("CID verification before reading or pinning blocks", { concurrency: false, timeout: 5000 }, () => {
	for (const localStorageOnly of [false, true]) {
		test(`a valid cached block is returned without HTTP when localStorageOnly=${localStorageOnly}`, async (t) => {
			const f = await fixture(t)
			await f.storage.put(f.key, uint8ArrayToHexString(f.block.dagCborEncodedData))
			assert.deepEqual(await f.resolver.getBlock(f.block.cid, localStorageOnly), f.block.dagCborEncodedData)
			assert.equal(f.fetch.mock.callCount(), 0)
		})

		test(`a corrupt cached block rejects its caller when localStorageOnly=${localStorageOnly}`, async (t) => {
			const f = await fixture(t)
			await f.storage.put(f.key, uint8ArrayToHexString(f.differentBlock.dagCborEncodedData))
			await assert.rejects(f.resolver.getBlock(f.block.cid, localStorageOnly), /IPFS Cache returned invalid data/)
			assert.equal(f.fetch.mock.callCount(), 0)

			// Replacing the bad cache entry allows the same request to succeed.
			await f.storage.put(f.key, uint8ArrayToHexString(f.block.dagCborEncodedData))
			assert.deepEqual(await f.resolver.getBlock(f.block.cid, localStorageOnly), f.block.dagCborEncodedData)
		})
	}

	test("a corrupt cached child rejects tree resolution before it can return a payload iterator", async (t) => {
		const f = await fixture(t)
		const root = await encodeBlock({ L: f.block.cid, R: f.differentBlock.cid })
		await f.storage.put(`ipfs:block:${root.cid}`, uint8ArrayToHexString(root.dagCborEncodedData))
		await f.storage.put(f.key, uint8ArrayToHexString(f.differentBlock.dagCborEncodedData))
		await f.storage.put(
			`ipfs:block:${f.differentBlock.cid}`,
			uint8ArrayToHexString(f.differentBlock.dagCborEncodedData)
		)
		await assert.rejects(f.resolver.fullyResolveCID(root.cid), /IPFS Cache returned invalid data/)
		assert.equal(f.fetch.mock.callCount(), 0)
	})

	test("pinning verified bytes requires CID confirmation and succeeds on retry", async (t) => {
		const f = await fixture(t)
		f.fetch.mock.mockImplementationOnce(
			async () => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } })
		)
		await assert.rejects(f.pinner.putAndPin(f.block, f.account), /Invalid block\/put response/)
		await f.pinner.putAndPin(f.block, f.account)
		assert.equal(f.fetch.mock.callCount(), 2)
		const [input, init] = f.fetch.mock.calls[1].arguments
		assert.ok(input)
		const url = new URL(input instanceof Request ? input.url : input.toString())
		assert.equal(url.pathname, "/api/v0/block/put")
		assert.equal(url.searchParams.get("pin"), "true")
		assert.equal(init?.method, "POST")
		assert.ok(init.body instanceof FormData)
		const data = init.body.get("data")
		assert.ok(data instanceof Blob)
		assert.deepEqual(new Uint8Array(await data.arrayBuffer()), f.block.dagCborEncodedData)
	})

	for (const remotePin of [false, true]) {
		test(`a mismatched CID/data pair is rejected before any upload when remotePin=${remotePin}`, async (t) => {
			const f = await fixture(t, remotePin)
			const invalid = { cid: f.block.cid, dagCborEncodedData: f.differentBlock.dagCborEncodedData }
			await assert.rejects(f.pinner.putAndPin(invalid, f.account), /does not match dag-cbor-encoded-data/)
			assert.equal(f.fetch.mock.callCount(), 0)
		})
	}
})
