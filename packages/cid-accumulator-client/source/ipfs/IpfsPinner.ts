import { createLogger } from "../utils/logging.js"
import { getRemotePinningServices, postIpfsBinary, verifyCIDAgainstDagCborEncodedData } from "./utils.js"
import { RemotePinningService } from "./RemotePinningService.js"

import type { CID } from "./CID.js"
import type { CIDDataPair } from "./types.js"
import type { IpfsPinnerConfig } from "./IpfsPinner.types.js"
import type { LifecycleComponent, RateLimiterOptions } from "../types/common.js"
import type { Storage } from "../storage/interface.js"
import type { EthereumAddress } from "../ethereum/EthereumAddress.js"

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

	private storage: Storage
	private initialized: boolean = false

	constructor(storage: Storage, config: Required<IpfsPinnerConfig>) {
		this.storage = storage
		this.baseUrl = config.baseUrl
		this.remotePin = config.remotePin
		this.remotePinningServiceRateLimiterOptions = config.remotePinningServiceRateLimiterOptions
	}

	/**
	 * Initialize the IPFS pinner
	 * This will fetch and initialize all available remote pinning services if remotePin is enabled
	 */
	async init(): Promise<void> {
		if (!this.remotePin) return
		// Get list of remote pinning services
		const services = await getRemotePinningServices(this.baseUrl)

		// Create a RemotePinningService instance for each remote pinning service
		for (const serviceName of services) {
			if (this.remotePinningServices.has(serviceName)) continue
			const service = new RemotePinningService(this.storage, {
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

	/**
	 * PUT dag-cbor-encoded-data in the node and PIN the CID. Throw if the CID does not match what was expected.
	 * See: https://docs.ipfs.tech/reference/kubo/rpc/#api-v0-pin-remote-add
	 */
	async putAndPin({ cid, dagCborEncodedData }: CIDDataPair, account: EthereumAddress): Promise<void> {
		//this.logger.log(`Pinning CID ${cid.toString()} for account ${account.toString()}`)
		if (!(await verifyCIDAgainstDagCborEncodedData(dagCborEncodedData, cid))) {
			throw new Error(`[KuboIpfsPinner] Input CID ${cid.toString()} does not match dag-cbor-encoded-data`)
		}
		const res = await postIpfsBinary(
			this.baseUrl,
			"block/put",
			{ format: "dag-cbor", mhtype: "sha2-256", "cid-version": "1", pin: "true" },
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
		await this.handleRemotePinning(cid, account)
	}

	/**
	 * Handle pinning to remote services
	 * @param cid - CID to pin
	 * @param account - Optional account identifier to use in the name for the pin
	 */
	private async handleRemotePinning(cid: CID<unknown, 113, 18, 1>, account: EthereumAddress): Promise<void> {
		if (!this.remotePin) return
		if (!this.initialized) await this.init()
		if (this.remotePinningServices.size === 0) return

		await Promise.all(
			Array.from(this.remotePinningServices.entries()).map(async ([serviceName, service]) => {
				const result = await service.pin(cid, `cid-accumulator-${account}`)
				// Retain failed services so a later retry cannot silently skip a configured destination.
				if (!result.success) throw new Error(`[IpfsPinner] Remote pinning failed for service '${serviceName}'`)
			})
		)
	}
}
