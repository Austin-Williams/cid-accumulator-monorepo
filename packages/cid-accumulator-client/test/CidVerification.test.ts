import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { TestContext } from "node:test"
import { defaultIpfsPinnerConfig, defaultLightClientIpfsResolverConfig } from "../source/config/defaultConfig.js"
import { EthereumAddress } from "../source/ethereum/EthereumAddress.js"
import { IpfsPinner } from "../source/ipfs/IpfsPinner.js"
import { IpfsResolver } from "../source/ipfs/IpfsResolver.js"
import { InMemoryAdapter } from "../source/storage/adapters/InMemoryAdapter.js"
import { encodeBlock, encodeLinkNode, uint8ArrayToHexString } from "../source/utils/codec.js"

test("DAG-CBOR leaf and link CIDs match fixed Keccak-256 vectors", async () => {
	const left = await encodeBlock(Uint8Array.of(0xde, 0xad, 0xbe, 0xef))
	const right = await encodeBlock(Uint8Array.of(1))
	assert.equal(uint8ArrayToHexString(left.dagCborEncodedData), "44deadbeef")
	assert.equal(left.cid.toString(), "bafyrwif32u7d5blknsc7f6vs5pot4gegdcsgw47tw2mfb4oap7nbnjkdsq")
	assert.equal(right.cid.toString(), "bafyrwihmla4kpfp7b5kcapznmydaipimdj3ydm53w4a242q4o5lts4dyku")
	const link = await encodeLinkNode(left.cid, right.cid)
	assert.equal(link.toString(), "bafyrwigkuv7we2ym3kbhjkexqnelrow5mlox7t7j7eoiq6lt5bdyvv3c4m")
	assert.equal((await encodeBlock({ L: left.cid, R: right.cid })).cid.toString(), link.toString())
})

async function fixture(t: TestContext, remotePin = false) {
	const block = await encodeBlock(Uint8Array.of(1))
	const differentBlock = await encodeBlock(Uint8Array.of(2))
	const storage = new InMemoryAdapter()
	const resolver = new IpfsResolver(storage, defaultLightClientIpfsResolverConfig)
	const pinner = new IpfsPinner(storage, {
		...defaultIpfsPinnerConfig,
		baseUrl:
			"https://ipfs.example.test/proxy/api/v0/?token=a%2Bb%2Fc%3D&pin=false&arg=stale-cid&service=stale-service&status=failed",
		remotePin,
		remotePinningServiceRateLimiterOptions: { intervalMs: 0, maxRetries: 2, baseDelay: 0, capDelay: 0 },
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
		const f = await fixture(t, true)
		let localCID = f.block.cid.toString()
		let remoteAdds = 0
		let remoteAvailable = true
		f.fetch.mock.mockImplementation(async (input) => {
			const url = new URL(input instanceof Request ? input.url : input.toString())
			switch (url.pathname) {
				case "/proxy/api/v0/block/put":
					return Response.json({ Key: localCID })
				case "/proxy/api/v0/pin/remote/service/ls":
					return Response.json({ RemoteServices: [{ Service: "test-pinner" }] })
				case "/proxy/api/v0/pin/remote/ls":
					return Response.json({})
				case "/proxy/api/v0/pin/remote/add":
					remoteAdds++
					assert.deepEqual(url.searchParams.getAll("arg"), [localCID])
					assert.deepEqual(url.searchParams.getAll("service"), ["test-pinner"])
					return remoteAdds === 1 || !remoteAvailable
						? new Response("Temporarily unavailable", { status: 503 })
						: Response.json({ Cid: localCID, Status: "queued" })
				default:
					throw new Error(`Unexpected HTTP request: ${url}`)
			}
		})
		f.fetch.mock.mockImplementationOnce(
			async () => new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } })
		)
		await assert.rejects(f.pinner.putAndPin(f.block, f.account), /Invalid block\/put response/)
		assert.equal(f.fetch.mock.callCount(), 1)
		await f.pinner.putAndPin(f.block, f.account)
		assert.equal(remoteAdds, 2, "A transient remote failure must be retried before reporting success")
		const requests = f.fetch.mock.calls.map(({ arguments: [input] }) => {
			assert.ok(input)
			return new URL(input instanceof Request ? input.url : input.toString())
		})
		for (const request of requests) assert.deepEqual(request.searchParams.getAll("token"), ["a+b/c="])
		const statusRequest = requests.find((request) => request.pathname === "/proxy/api/v0/pin/remote/ls")
		assert.ok(statusRequest)
		assert.equal(statusRequest.searchParams.get("cid"), localCID)
		assert.deepEqual(statusRequest.searchParams.getAll("service"), ["test-pinner"])
		assert.deepEqual(statusRequest.searchParams.getAll("status"), ["pinned", "pinning", "queued"])
		const [input, init] = f.fetch.mock.calls[1].arguments
		assert.ok(input)
		const url = new URL(input instanceof Request ? input.url : input.toString())
		assert.equal(url.pathname, "/proxy/api/v0/block/put")
		assert.deepEqual(url.searchParams.getAll("pin"), ["true"])
		assert.deepEqual(url.searchParams.getAll("mhtype"), ["keccak-256"])
		assert.equal(init?.method, "POST")
		assert.ok(init.body instanceof FormData)
		const data = init.body.get("data")
		assert.ok(data instanceof Blob)
		assert.deepEqual(new Uint8Array(await data.arrayBuffer()), f.block.dagCborEncodedData)

		localCID = f.differentBlock.cid.toString()
		remoteAvailable = false
		await assert.rejects(f.pinner.putAndPin(f.differentBlock, f.account))
		assert.equal(remoteAdds, 5, "Remote failure must reach the caller after exhausting both retries")
		remoteAvailable = true
		await f.pinner.putAndPin(f.differentBlock, f.account)
		assert.equal(remoteAdds, 6, "Exhaustion must allow a later attempt to recover")
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
