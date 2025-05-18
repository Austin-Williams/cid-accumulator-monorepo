import type { RemotePinningServiceConfig } from "./RemotePinningService.types"
import { RateLimiter } from "../utils/rateLimiter"
import { createLogger } from "../utils/logging"
import type { Storage } from "../storage/interface"
import type { Logger } from "../types/common"
import { CID } from "./CID"
import type { IpfsErrorCheckResult, RemotePinningResult } from "./RemotePinningService.types"

/**
 * A class to handle interactions with a remote pinning service
 */
export class RemotePinningService {
	private readonly logger: Logger
	private readonly baseUrl: string
	private readonly serviceName: string
	private readonly storage: Storage
	public readonly rateLimiter: RateLimiter
	private readonly pendingPins: Set<string> = new Set()

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
		const url = new URL(`${this.baseUrl}/pin/remote/ls`)
		url.searchParams.append("cid", cid.toString())
		url.searchParams.append("service", this.serviceName)
		url.searchParams.append("status", "pinned")
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
	 * @returns True if the pin was successful, false otherwise
	 */
	private async sendRemotePinRequest(cid: CID<unknown, 113, 18, 1>, name: string): Promise<RemotePinningResult> {
		const url = new URL(`${this.baseUrl}/pin/remote/add`)
		url.searchParams.append("arg", cid.toString())
		url.searchParams.append("service", this.serviceName)
		url.searchParams.append("name", name)
		url.searchParams.append("background", "true")
		const result: RemotePinningResult = await this.rateLimiter.execute(async () => {
			try {
				const response = await fetch(url.toString(), { method: "POST" })

				// Check if the request was successful
				if (response.ok) {
					this.pendingPins.delete(cid.toString())
					return { success: true, skipService: false }
				} else {
					// Try to read the error response for more details
					let errorDetails = response.statusText
					try {
						const text = await response.text()
						if (text && text.trim() !== "") {
							errorDetails += ` - ${text}`
						}
					} catch (readError) {
						// Ignore read errors
					}

					this.logger.warn(`Failed to pin CID ${cid.toString()} on remote service ${this.serviceName}: ${errorDetails}`)
					this.pendingPins.delete(cid.toString())
					return { success: false, skipService: false }
				}
			} catch (error) {
				// There are three cases of error messages we need to handle differently
				const errorMessage = error instanceof Error ? error.message : String(error)
				const errorCheck = checkIpfsNonRetriableError(errorMessage)
				this.logger.warn(`errorMessage: ${errorMessage}, errorCheck: ${JSON.stringify(errorCheck)}`)

				// If the error is "already pinned", we can consider this a success and update storage
				if (errorCheck.isNonRetriable && errorCheck.errorType === "already_pinned") {
					// Mark as pinned in storage
					await this.storage.put(this.getPinKey(cid), "true")
					this.pendingPins.delete(cid.toString())
					return { success: true, skipService: false }
				}

				// For other non-retriable errors, suggest skipping this remote pinning service in the future
				if (errorCheck.isNonRetriable) {
					this.logger.warn(
						`Non-retriable error pinning CID ${cid.toString()}: ${errorMessage} (errorType: ${errorCheck.errorType
						}). Consider removing this remote pinning service.`
					)
					this.pendingPins.delete(cid.toString())
					return { success: false, skipService: true }
				}

				// For retriable errors, don't skip the service but report failure
				this.logger.warn(`Retriable error pinning CID ${cid.toString()}: ${errorMessage}`)
				this.pendingPins.delete(cid.toString())
				return { success: false, skipService: false }
			}
		})
		this.pendingPins.delete(cid.toString())
		return result
	}

	/**
	 * Pin a CID to this remote pinning service
	 * @param cid - The CID to pin
	 * @param name - Optional name for the pin
	 * @returns A result object indicating success or failure
	 */
	async pin(cid: CID<unknown, 113, 18, 1>, name: string): Promise<RemotePinningResult> {
		// Check if this CID is already being processed by another request
		if (this.pendingPins.has(cid.toString())) {
			this.logger.log(`CID ${cid.toString()}, pin already in progress, skipping duplicate request.`)
			return { success: true, skipService: false }
		} else {
			// Add this CID to the pending set to prevent duplicate requests
			this.pendingPins.add(cid.toString())
		}

		// Check if we've already marked this as pinned in storage
		if (await this.isAlreadyPinnedInStorage(cid)) {
			this.pendingPins.delete(cid.toString())
			return { success: true, skipService: false }
		}

		// Ask the remote pinning service if the CID is already pinned
		const remotePinnedStatus = await this.checkRemotePinStatus(cid)

		if (remotePinnedStatus === "pinned") {
			// The CID has already been remote-pinned, let's indicate that in storage
			await this.storage.put(this.getPinKey(cid), "true")
			// Remove from pending set since we're finished with this CID
			this.pendingPins.delete(cid.toString())
			return { success: true, skipService: false }
		}

		if (remotePinnedStatus === "pinning" || remotePinnedStatus === "queued") {
			// The CID is already not yet remote-pinned, but is being processed by the remote pinner
			this.pendingPins.delete(cid.toString())
			return { success: true, skipService: false }
		}

		// If we get here, the CID is not pinned, so we need to pin it
		// Remote pinning requests take a long time to complete, so we don't wait for them to finish
		await this.sendRemotePinRequest(cid, name)
		return { success: true, skipService: false }
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
		/DUPLICATE_OBJECT/i, // Specific case for Pinata
		/already pinned/i, // Generic case
		/Pin.already_pinned/i, // IPFS 0.5+
		/CID already pinned/i, // Another variant
		/already exists/i, // Another variant
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
