import type { RemotePinningServiceConfig } from "./RemotePinningService.types.js"
import { RateLimiter } from "../utils/rateLimiter.js"
import { buildIpfsUrl } from "./utils.js"
import { fetchWithRedactedErrors } from "../utils/http.js"

const pinStatuses = ["pinned", "pinning", "queued", "failed"] as const
interface RemotePin {
	Cid: string
	Name: string
	Status: (typeof pinStatuses)[number]
}

/** Manage named accumulator roots through one of Kubo's configured remote pinning services. */
export class RemotePinningService {
	private readonly pendingPins = new Map<string, Promise<void>>()
	public readonly rateLimiter: RateLimiter

	constructor(private readonly config: Required<RemotePinningServiceConfig>) {
		this.rateLimiter = new RateLimiter(config.rateLimiterOptions)
	}

	async list(name: string, cid?: string): Promise<RemotePin[]> {
		return this.rateLimiter.execute(async () => {
			const url = this.pinFilter("pin/remote/ls", name, cid)
			const response = await fetchWithRedactedErrors(url.toString(), { method: "POST" })
			if (!response.ok) throw new Error(`IPFS pin/remote/ls failed: ${response.status} ${await response.text()}`)
			// Kubo streams one JSON object per matching pin, and an empty body for zero matches.
			const pins: RemotePin[] = []
			for (const line of (await response.text()).split("\n")) {
				if (!line.trim()) continue
				const pin = JSON.parse(line)
				if (typeof pin.Cid !== "string" || typeof pin.Name !== "string" || !pinStatuses.includes(pin.Status)) {
					throw new Error("Invalid pin/remote/ls response")
				}
				if (pin.Name === name && (!cid || pin.Cid === cid)) pins.push(pin)
			}
			return pins
		})
	}

	pin(cid: string, name: string): Promise<void> {
		const key = `${name}:${cid}`
		const pending = this.pendingPins.get(key)
		if (pending) return pending
		const pin = this.pinOnce(cid, name).finally(() => this.pendingPins.delete(key))
		this.pendingPins.set(key, pin)
		return pin
	}

	private async pinOnce(cid: string, name: string): Promise<void> {
		const pins = await this.list(name, cid)
		if (pins.some(pin => pin.Status !== "failed")) return
		if (pins.length) await this.unpin(cid, name)

		const url = buildIpfsUrl(this.config.baseUrl, "pin/remote/add", {
			arg: cid, service: this.config.serviceName, name, background: "true",
		})
		const result = await this.rateLimiter.execute(async () => {
			const response = await fetchWithRedactedErrors(url.toString(), { method: "POST" })
			if (response.ok) {
				const pin = await response.json()
				if (pin.Cid !== cid || pin.Name !== name || !pinStatuses.includes(pin.Status) || pin.Status === "failed") {
					throw new Error(`Remote service '${this.config.serviceName}' did not accept root ${cid}`)
				}
				return
			}

			const details = await response.text()
			const error = new Error(`IPFS pin/remote/add failed for ${this.config.serviceName}: ${response.status} ${details}`)
			if (/already (?:being )?pinned|already_pinned|already in pin queue/i.test(details)) return "duplicate"
			// Return terminal errors to the caller without consuming transient retries.
			if (response.status === 401 || response.status === 403 || /forbidden|paid account/i.test(details)) return error
			throw error
		})
		if (result instanceof Error) throw result
		if (result === "duplicate" && !(await this.list(name, cid)).some(pin => pin.Status !== "failed")) {
			throw new Error(`Remote service '${this.config.serviceName}' already has ${cid} under another pin`)
		}
	}

	async unpin(cid: string, name: string): Promise<void> {
		await this.rateLimiter.execute(async () => {
			// Filter by both name and CID, including queued/failed requests from previous attempts.
			const url = this.pinFilter("pin/remote/rm", name, cid)
			url.searchParams.set("force", "true")
			const response = await fetchWithRedactedErrors(url.toString(), { method: "POST" })
			if (!response.ok) throw new Error(`IPFS pin/remote/rm failed: ${response.status} ${await response.text()}`)
		})
	}

	private pinFilter(endpoint: string, name: string, cid?: string): URL {
		const url = buildIpfsUrl(this.config.baseUrl, endpoint, {
			service: this.config.serviceName, name, cid, arg: undefined, status: undefined,
		})
		for (const status of pinStatuses) url.searchParams.append("status", status)
		return url
	}
}
