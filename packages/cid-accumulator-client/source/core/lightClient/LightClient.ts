import { DataClient } from "../dataClient/DataClient.js"
import { EthereumAddress } from "../../ethereum/EthereumAddress.js"
import { createLogger } from "../../utils/logging.js"

import type { DataClientDependencies } from "../dataClient/DataClient.types.js"
import type { LifecycleComponent } from "../../types/common.js"

export class LightClient extends DataClient implements LifecycleComponent {
	spinUpOrder: LifecycleComponent[]
	initialized: boolean = false
	running: boolean = false

	constructor(accountAddress: EthereumAddress, dependencies: DataClientDependencies) {
		super(accountAddress, dependencies)
		this.spinUpOrder = [
			dependencies.storage,
			dependencies.accumulatorContract,
			dependencies.eventCacheService,
			dependencies.ipfsResolver,
		]
		this.logger = createLogger(`LightClient ${accountAddress.toString()}`)
	}

	/**
	 * @notice Initializes all dependencies of the light client
	 * @dev Dependencies are initialized in the correct order
	 * @returns Promise that resolves when initialization is complete
	 */
	async init(): Promise<void> {
		if (this.initialized) {
			this.logger.warn("Already initialized. Skipping initialization.")
			return
		}

		this.logger.log("Initializing...")

		try {
			for (const component of this.spinUpOrder) await component.init()
		} catch (error) {
			this.logger.error(`Initialization failed: ${error}`)
			throw error
		}

		this.initialized = true
		this.logger.log("Initialization complete")
	}

	/**
	 * @notice Starts the light client dependencies
	 * @dev Dependencies are started in the correct order
	 * @returns Promise that resolves when the service is started
	 */
	async start(): Promise<void> {
		if (this.running) {
			this.logger.warn("Already running. Skipping start.")
			return
		}

		this.running = true

		try {
			if (!this.initialized) await this.init()
			this.logger.log("Starting services...")
			for (const component of this.spinUpOrder) await component.start()
			// start syncing (blocking)
			try {
				await this.sync()
			} catch (error) {
				this.logger.error(`Failed to sync light client: ${error}`)
				throw error
			}
		} catch (error) {
			this.logger.error(`Failed to start light client services: ${error}`)
			throw error
		}

		this.logger.log("All services started successfully, and client is synced.")
	}

	/**
	 * @notice Stops the light client dependencies
	 * @dev Dependencies are stopped in reverse order of initialization
	 */
	stop(): void {
		if (!this.running) {
			this.logger.warn("Not running, nothing to stop")
			return
		}

		this.logger.log("Stopping services...")

		const errors: Error[] = []
		for (const component of this.spinUpOrder.slice().reverse()) {
			try {
				component.stop()
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error)
				this.logger.error(`Error stopping component ${component.constructor?.name ?? ""}: ${msg}`)
				errors.push(error instanceof Error ? error : new Error(msg))
			}
		}

		this.running = false
		this.initialized = false
		if (errors.length > 0) {
			const aggMsg = errors.map((e, i) => `[${i + 1}] ${e.message}`).join("; ")
			throw new Error(`One or more errors occurred during shutdown: ${aggMsg}`)
		}
		this.logger.log("Gracefully shut down")
	}
}
