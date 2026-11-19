import { createLogger } from "../utils/logging.js"
import { getRemotePinningServices, postIpfsBinary, postIpfsEmpty, verifyCIDAgainstDagCborEncodedData } from "./utils.js"
import { RemotePinningService } from "./RemotePinningService.js"

import type { CIDDataPair } from "./types.js"
import type { IpfsPinnerConfig } from "./IpfsPinner.types.js"
import type { LifecycleComponent, RateLimiterOptions } from "../types/common.js"

/**
 * KuboIpfsPinner implements IpfsPinner using the Kubo (Go) IPFS HTTP API.
 * See https://docs.ipfs.tech/reference/kubo/rpc/
 *
 * This requires a Kubo IPFS node to be running.
 * A user-friendly way to run a Kubo IPFS node is to simply install IPFS Desktop
 * See: https://docs.ipfs.tech/install/ipfs-desktop/
 * With IPFS Desktop running on your machine, this KuboIpfsPinner should
 * work out of the box in a NodeJs environment.
 *
 * In order to work in a browser environment, you should also install the IPFS Companion Browser extension
 * See: https://docs.ipfs.tech/install/ipfs-companion/
 *
 * For remote pinning (which is optional), you need to have at least one remote pinning service set up.
 * You can do this via command like via:
 * $ ipfs pin remote service add <service-name> <api-url> <jwt-secret>
 * See: https://docs.ipfs.tech/how-to/work-with-pinning-services/#ipfs-kubo
 *
 * @param baseUrl - Base URL of the IPFS HTTP API
 * @param remotePin - Whether to pin to all the remote IPFS pinning services you have configured on your node.
 *
 */
export class IpfsPinner implements LifecycleComponent {
	public readonly baseUrl: string
	public readonly remotePin: boolean
	public readonly remotePinningServices: Map<string, RemotePinningService> = new Map()
	private remotePinningServiceRateLimiterOptions: RateLimiterOptions
	private readonly logger = createLogger("IpfsPinner")

	private initialized: boolean = false

	constructor(config: Required<IpfsPinnerConfig>) {
		this.baseUrl = config.baseUrl
		this.remotePin = config.remotePin
		this.remotePinningServiceRateLimiterOptions = config.remotePinningServiceRateLimiterOptions
	}

	/**
	 * Initialize the IPFS pinner
	 * This will fetch and initialize all available remote pinning services if remotePin is enabled
	 */
	async init(): Promise<void> {
		if (!this.remotePin || this.initialized) return
		// Get list of remote pinning services
		const services = await getRemotePinningServices(this.baseUrl)

		// Create a RemotePinningService instance for each remote pinning service
		for (const serviceName of services) {
			if (this.remotePinningServices.has(serviceName)) continue
			const service = new RemotePinningService({
				baseUrl: this.baseUrl,
				serviceName,
				rateLimiterOptions: this.remotePinningServiceRateLimiterOptions,
			})
			this.remotePinningServices.set(serviceName, service)
		}

		this.logger.log(`Initialized ${this.remotePinningServices.size} remote pinning services`)
		this.initialized = true
	}

	public async start(): Promise<void> {
		// noop
		return
	}

	public stop(): void {
		this.initialized = false
		this.remotePinningServices.forEach((service, serviceName) => {
			this.remotePinningServices.delete(serviceName)
			service.rateLimiter.clearQueue()
		})
	}

	/** Upload a verified block. Its reachable roots control how long Kubo retains it. */
	async putBlock({ cid, dagCborEncodedData }: CIDDataPair): Promise<void> {
		if (!(await verifyCIDAgainstDagCborEncodedData(dagCborEncodedData, cid))) {
			throw new Error(`[KuboIpfsPinner] Input CID ${cid.toString()} does not match dag-cbor-encoded-data`)
		}
		const res = await postIpfsBinary(
			this.baseUrl,
			"block/put",
			{ "cid-codec": "dag-cbor", mhtype: "keccak-256", pin: "false", arg: undefined },
			dagCborEncodedData
		)

		// HTTP success alone does not confirm that the node accepted this block.
		const returnedCID = res?.Key
		if (typeof returnedCID !== "string" || returnedCID.length === 0) {
			throw new Error("[IpfsPinner] Invalid block/put response: expected a non-empty CID in Key")
		}
		if (returnedCID !== cid.toString()) {
			throw new Error(`[IpfsPinner] Mismatched CID returned from IPFS: expected ${cid.toString()}, got ${returnedCID}`)
		}
	}

	/** Discover our root pins on all destinations, including partially completed operations. */
	async listRootPins(name: string): Promise<{ local: Set<string>; all: Set<string> }> {
		await this.init()
		const pins = await this.localPins("recursive", { name, arg: undefined })
		// Kubo's local name filter is a substring match.
		const local = new Set(Object.keys(pins).filter(cid => pins[cid].Name === name))
		const all = new Set(local)
		for (const service of this.remotePinningServices.values()) {
			for (const pin of await service.list(name)) all.add(pin.Cid)
		}
		return { local, all }
	}

	async pinRoot(cid: string, name: string): Promise<void> {
		// Kubo has only one local pin per CID. Adding it again would replace its name.
		const recursive = await this.localPin(cid, "recursive")
		if (recursive?.Name && recursive.Name !== name) {
			throw new Error(`Root ${cid} already has a recursive pin named '${recursive.Name}' on this Kubo node`)
		}
		// An unnamed recursive pin (including earlier seeder pins) already protects the root.
		if (!recursive) {
			if (await this.localPin(cid, "direct")) {
				throw new Error(`Cannot recursively pin ${cid} without replacing an existing direct pin`)
			}
			const result = await postIpfsEmpty(this.baseUrl, "pin/add", { arg: cid, name, recursive: "true" })
			if (!Array.isArray(result?.Pins) || !result.Pins.includes(cid)) throw new Error(`Kubo did not confirm pinning ${cid}`)
		}
		await this.init()
		for (const service of this.remotePinningServices.values()) await service.pin(cid, name)
	}

	async unpinRoot(cid: string, name: string): Promise<void> {
		await this.init()
		for (const service of this.remotePinningServices.values()) await service.unpin(cid, name)
		const pin = await this.localPin(cid, "recursive")
		if (pin?.Name === name) {
			const result = await postIpfsEmpty(this.baseUrl, "pin/rm", { arg: cid, recursive: "true" })
			if (!Array.isArray(result?.Pins) || !result.Pins.includes(cid)) throw new Error(`Kubo did not confirm unpinning ${cid}`)
		}
	}

	private async localPin(cid: string, type: "recursive" | "direct"): Promise<{ Name?: string } | undefined> {
		try {
			const pins = await this.localPins(type, { arg: cid, name: undefined })
			return pins[cid]
		} catch (error) {
			// pin/ls with a CID returns an error if it has no pin of the requested type.
			if (error instanceof Error && error.message.includes(`path '${cid}' is not pinned`)) return undefined
			throw error
		}
	}

	private async localPins(
		type: "recursive" | "direct", filter: { arg?: string; name?: string }
	): Promise<Record<string, { Type: string; Name?: string }>> {
		const result = await postIpfsEmpty(this.baseUrl, "pin/ls", { ...filter, type, names: "true", stream: "false" })
		// Kubo omits Keys when there are no matches.
		if (result && typeof result === "object" && !Array.isArray(result)) {
			if (Object.keys(result).length === 0) return {}
			if (result.Keys && typeof result.Keys === "object" && !Array.isArray(result.Keys)) return result.Keys
		}
		throw new Error("[IpfsPinner] Invalid pin/ls response")
	}
}
