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
	private initializedComponents: LifecycleComponent[] = []
	private lifecycleGeneration = 0
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
		const generation = this.lifecycleGeneration
		if (this.initialized) {
			this.logger.warn("Already initialized. Skipping initialization.")
			return
		}

		this.logger.log("Initializing...")

		try {
			await this.dependencies.dataClientManager.connectChainNotifications()
			if (generation !== this.lifecycleGeneration) return
			for (const component of this.spinUpOrder) {
				await component.init()
				if (generation !== this.lifecycleGeneration) {
					component.stop()
					return
				}
				this.initializedComponents.push(component)
			}
		} catch (error) {
			this.logger.error(`Initialization failed: ${error}`)
			if (generation === this.lifecycleGeneration) this.stopInitializedComponents()
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
		const generation = this.lifecycleGeneration

		try {
			await this.dependencies.dataClientManager.connectChainNotifications()
			if (generation !== this.lifecycleGeneration) return
			if (!this.initialized) await this.init()
			if (generation !== this.lifecycleGeneration) return
			this.logger.log("Starting services...")
			for (const component of this.spinUpOrder) {
				await component.start()
				if (generation !== this.lifecycleGeneration) {
					component.stop()
					return
				}
			}
		} catch (error) {
			this.logger.error(`Failed to start seeder services: ${error}`)
			if (generation === this.lifecycleGeneration) this.stopInitializedComponents()
			throw error
		}

		this.logger.log("All services started successfully")
	}

	/**
	 * @notice Stops the seeder dependencies
	 * @dev Dependencies are stopped in reverse order of initialization
	 */
	stop(): void {
		this.lifecycleGeneration++
		if (!this.running && this.initializedComponents.length === 0) {
			this.dependencies.dataClientManager.stop()
			this.logger.warn("Not running, nothing to stop")
			return
		}

		this.logger.log("Stopping services...")

		const errors = this.stopInitializedComponents()
		if (errors.length > 0) {
			const aggMsg = errors.map((e, i) => `[${i + 1}] ${e.message}`).join("; ")
			throw new Error(`One or more errors occurred during shutdown: ${aggMsg}`)
		}
		this.logger.log("Gracefully shut down")
	}

	private stopInitializedComponents(): Error[] {
		this.lifecycleGeneration++
		this.running = false
		this.initialized = false
		const errors: Error[] = []
		// A failed storage init must not trigger stop(), which may persist an uninitialized store.
		const components = this.initializedComponents.splice(0).reverse()
		// Notification preparation may precede a failed storage/component initialization.
		if (!components.includes(this.dependencies.dataClientManager)) components.unshift(this.dependencies.dataClientManager)
		for (const component of components) {
			try {
				component.stop()
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error)
				this.logger.error(`Error stopping component ${component.constructor?.name ?? ""}: ${msg}`)
				errors.push(error instanceof Error ? error : new Error(msg))
			}
		}

		return errors
	}
}
