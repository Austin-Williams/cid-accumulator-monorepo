import { createLogger } from "../../utils/logging.js"

import type { LifecycleComponent, Logger } from "../../types/common.js"
import type { SeederDependencies } from "./Seeder.types.js"

/**
 * Seeder class coordinates the components needed to monitor and process
 * CID accumulator data from the blockchain
 * @notice This is the main entry point for seeders participating in the CID Accumulator backend
 * @dev Manages the lifecycle of all component classes (AccountRegistry, EventCoordinator, DataClientManager)
 * @dev Handles initialization, starting, and stopping of all components
 * @dev Provides access to the underlying components for advanced usage
 */
export class Seeder {
	public readonly dependencies: SeederDependencies
	public readonly spinUpOrder: LifecycleComponent[]
	public initialized: boolean = false
	public running: boolean = false
	private logger: Logger

	/**
	 * Creates a new Seeder instance
	 * @param dependencies Dependencies for the seeder
	 */
	constructor(dependencies: SeederDependencies) {
		this.dependencies = dependencies
		this.spinUpOrder = [
			this.dependencies.storage,
			this.dependencies.accumulatorContract,
			this.dependencies.eventCacheService,
			this.dependencies.accountRegistryService,
			this.dependencies.dataClientManager,
			this.dependencies.pinningService,
		]
		this.logger = createLogger("Seeder")
	}

	/**
	 * @notice Initializes all dependencies of the seeder
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
	 * @notice Starts the seeder dependencies
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
		} catch (error) {
			this.logger.error(`Failed to start seeder services: ${error}`)
			throw error
		}

		this.logger.log("All services started successfully")
	}

	/**
	 * @notice Stops the seeder dependencies
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
