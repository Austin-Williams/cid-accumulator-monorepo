import type { RemotePinningServiceConfig } from "./RemotePinningService.types.js"
import { RateLimiter } from "../utils/rateLimiter.js"
import { createLogger } from "../utils/logging.js"
import type { Storage } from "../storage/interface.js"
import type { Logger } from "../types/common.js"
import { CID } from "./CID.js"
import type { IpfsErrorCheckResult, RemotePinningResult } from "./RemotePinningService.types.js"
import { buildIpfsUrl } from "./utils.js"

/**
 * A class to handle interactions with a remote pinning service
 */
export class RemotePinningService {
	private readonly logger: Logger
	private readonly baseUrl: string
	private readonly serviceName: string
	private readonly storage: Storage
	public readonly rateLimiter: RateLimiter
	private readonly pendingPins = new Map<string, Promise<RemotePinningResult>>()

	/**
	 * Create a new RemotePinningService instance
	 * @param storage - Storage interface for persisting pin states
	 * @param baseUrl - Base URL of the IPFS HTTP API
	 * @param serviceName - Name of the remote pinning service
	 * @param rateLimiterOptions - Optional rate limiter configuration
	 */
	constructor(storage: Storage, config: Required<RemotePinningServiceConfig>) {
		this.storage = storage
		this.baseUrl = config.baseUrl
		this.serviceName = config.serviceName

		this.logger = createLogger(`RemotePinningService:${this.serviceName}`)
		this.logger.log(`Initialized RemotePinningService with name: ${this.serviceName}`)
		this.rateLimiter = new RateLimiter(config.rateLimiterOptions)
	}

	/**
	 * Get the name of this remote pinning service
	 */
	getName(): string {
		return this.serviceName
	}

	/**
	 * Get the storage key for a pinned CID
	 * @param cid - The CID that was pinned
	 * @returns The storage key
	 */
	private getPinKey(cid: CID<unknown, 113, 18, 1>): string {
		return `ipfs:remote-pinned:service:${this.serviceName}:cid:${cid.toString()}`
	}

	/**
	 * Check if a CID is already marked as pinned in local storage
	 * @param cid - The CID to check
	 * @returns True if the CID is marked as pinned in local storage
	 */
	private async isAlreadyPinnedInStorage(cid: CID<unknown, 113, 18, 1>): Promise<boolean> {
		const pinKey = this.getPinKey(cid)
		const isPinned = (await this.storage.get(pinKey)) === "true"
		return isPinned
	}

	/**
	 * Check if a CID is already pinned on the remote service
	 * @param cid - The CID to check
	 * @returns True if the CID is pinned on the remote service
	 */
	private async checkRemotePinStatus(cid: CID<unknown, 113, 18, 1>): Promise<"none" | "pinned" | "pinning" | "queued"> {
		const url = buildIpfsUrl(this.baseUrl, "pin/remote/ls", {
			cid: cid.toString(),
			service: this.serviceName,
			status: "pinned",
		})
		url.searchParams.append("status", "pinning")
		url.searchParams.append("status", "queued")

		type LsResponseBody = {
			Cid: string
			Name: string
			Status: string
		}

		let lsResponseBody: LsResponseBody
		try {
			lsResponseBody = await this.rateLimiter.execute(async () => {
				const response = await fetch(url.toString(), { method: "POST" })
				if (!response.ok) {
					throw new Error(`IPFS pin/remote/ls failed: ${response.status} ${response.statusText}`)
				}

				// Check if there's any content before trying to parse it
				const text = await response.text()
				if (!text || text.trim() === "") {
					return {} as LsResponseBody
				}

				try {
					return JSON.parse(text) as LsResponseBody
				} catch (parseError) {
					this.logger.warn(`Error parsing JSON response: ${parseError}\nResponse was: ${text}`)
					return {} as LsResponseBody
				}
			})
		} catch (error) {
			this.logger.warn(`Error checking pin status: ${error}`)
			lsResponseBody = {} as LsResponseBody
		}

		// Check if we have a valid CID in the response
		if (!lsResponseBody.Cid) return "none"

		try {
			// Compare the CIDs to make sure they match
			if (CID.parse(lsResponseBody.Cid).toString() !== cid.toString()) return "none"

			// Return the appropriate status
			if (lsResponseBody.Status === "pinned") return "pinned"
			if (lsResponseBody.Status === "pinning") return "pinning"
			if (lsResponseBody.Status === "queued") return "queued"
		} catch (error) {
			this.logger.warn(`Error parsing CID from response: ${error}`)
			return "none"
		}

		return "none"
	}

	/**
	 * Perform the actual remote pinning operation
	 * @param cid - The CID to pin
	 * @param name - Optional name for the pin
	 * @returns Whether the request was accepted, or a non-retriable failure result
	 * @throws The last error when transient failures exhaust the retry budget
	 */
	private async sendRemotePinRequest(cid: CID<unknown, 113, 18, 1>, name: string): Promise<RemotePinningResult> {
		const url = buildIpfsUrl(this.baseUrl, "pin/remote/add", {
			arg: cid.toString(),
			service: this.serviceName,
			name,
			background: "true",
		})
		return this.rateLimiter.execute(async () => {
			let responseStatus: number | undefined
			try {
				const response = await fetch(url.toString(), { method: "POST" })
				responseStatus = response.status
				// background=true confirms submission, not completed remote pinning.
				if (response.ok) return { success: true, skipService: false }
				const details = await response.text().catch(() => "")
				throw new Error(
					`IPFS pin/remote/add failed for ${this.serviceName}: ${response.status} ${response.statusText} ${details}`
				)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				const errorCheck = checkIpfsNonRetriableError(errorMessage)

				// This also includes requests already queued. Only a confirmed "pinned" status is persisted.
				if (errorCheck.isNonRetriable && errorCheck.errorType === "already_pinned") {
					return { success: true, skipService: false }
				}

				if (errorCheck.isNonRetriable || responseStatus === 401 || responseStatus === 403) {
					this.logger.warn(`Non-retriable remote pinning failure: ${errorMessage}`)
					return { success: false, skipService: true }
				}

				// Rejections, rather than failure result objects, activate the rate limiter's retries.
				throw error
			}
		})
	}

	/**
	 * Pin a CID to this remote pinning service
	 * @param cid - The CID to pin
	 * @param name - Optional name for the pin
	 * @returns A result object indicating success or failure
	 * @throws When transient failures exhaust the retry budget, or storage fails
	 */
	pin(cid: CID<unknown, 113, 18, 1>, name: string): Promise<RemotePinningResult> {
		const key = cid.toString()
		const pending = this.pendingPins.get(key)
		if (pending) return pending
		const pin = this.pinOnce(cid, name).finally(() => this.pendingPins.delete(key))
		this.pendingPins.set(key, pin)
		return pin
	}

	private async pinOnce(cid: CID<unknown, 113, 18, 1>, name: string): Promise<RemotePinningResult> {
		// Check if we've already marked this as pinned in storage
		if (await this.isAlreadyPinnedInStorage(cid)) {
			return { success: true, skipService: false }
		}

		// Ask the remote pinning service if the CID is already pinned
		const remotePinnedStatus = await this.checkRemotePinStatus(cid)

		if (remotePinnedStatus === "pinned") {
			// The CID has already been remote-pinned, let's indicate that in storage
			await this.storage.put(this.getPinKey(cid), "true")
			return { success: true, skipService: false }
		}

		if (remotePinnedStatus === "pinning" || remotePinnedStatus === "queued") {
			// The CID is already not yet remote-pinned, but is being processed by the remote pinner
			return { success: true, skipService: false }
		}

		// If we get here, the CID is not pinned, so we need to pin it
		// Remote pinning requests take a long time to complete, so we don't wait for them to finish
		return this.sendRemotePinRequest(cid, name)
	}
}

// Helpers

/**
 * Check if an IPFS error message indicates a non-retriable error condition
 * @param errorMessage - The error message to check
 * @returns An object indicating if the error is non-retriable and the error type
 */
export function checkIpfsNonRetriableError(errorMessage: string): IpfsErrorCheckResult {
	// Common error messages that indicate a CID is already pinned
	const alreadyPinnedPatterns = [
		/already pinned/i, // Generic case
		/Pin.already_pinned/i, // IPFS 0.5+
		/CID already pinned/i, // Another variant
		/already being pinned/i, // For pins in progress
		/already in pin queue/i, // For queued pins
	]

	for (const pattern of alreadyPinnedPatterns) {
		if (pattern.test(errorMessage)) {
			return { isNonRetriable: true, errorType: "already_pinned" }
		}
	}

	// Check for paid account/forbidden errors (they can come with 500 or 403 status codes)
	if (
		errorMessage.includes("FORBIDDEN") ||
		errorMessage.includes("paid account") ||
		errorMessage.includes("403 Forbidden")
	) {
		return { isNonRetriable: true, errorType: "service_limitation" }
	}

	// Default: retriable error
	return { isNonRetriable: false, errorType: "unknown" }
}
