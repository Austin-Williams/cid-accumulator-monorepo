import { DataClient } from "../dataClient/DataClient.js"
import { EthereumAddress } from "../../ethereum/EthereumAddress.js"
import { createLogger } from "../../utils/logging.js"

import type { DataClientDependencies } from "../dataClient/DataClient.types.js"
import type { LifecycleComponent } from "../../types/common.js"

export class LightClient extends DataClient implements LifecycleComponent {
	spinUpOrder: LifecycleComponent[]
	initialized: boolean = false
	running: boolean = false
	private startPromise?: Promise<void>
	private initPromise?: Promise<void>
	private initGeneration = 0
	private lifecycleGeneration = 0
	private initializedComponents: LifecycleComponent[] = []
	private unsubscribeFromEventCacheService?: () => void

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
		const generation = this.lifecycleGeneration
		// A canceled component.start() can still be acquiring resources. Let its cleanup finish first.
		if (!this.running && this.startPromise) {
			try {
				await this.startPromise
			} catch {
				// Failure of the canceled run does not prevent this new initialization request.
			}
			if (generation !== this.lifecycleGeneration) return
		}
		await this.initialize(generation)
	}

	private async initialize(generation: number): Promise<void> {
		if (generation !== this.lifecycleGeneration) return
		// A new run must wait for canceled initialization to release the shared components.
		while (this.initPromise) {
			const pendingGeneration = this.initGeneration
			try {
				await this.initPromise
			} catch (error) {
				if (pendingGeneration === generation) throw error
			}
			if (generation !== this.lifecycleGeneration) return
		}
		if (this.initialized) {
			this.logger.warn("Already initialized. Skipping initialization.")
			return
		}

		this.initGeneration = generation
		this.initPromise = Promise.resolve()
			.then(() => this.initializeComponents(generation))
			.finally(() => {
				this.initPromise = undefined
			})
		return this.initPromise
	}

	private async initializeComponents(generation: number): Promise<void> {
		if (generation !== this.lifecycleGeneration) return
		this.logger.log("Initializing...")

		try {
			for (const component of this.spinUpOrder) {
				await component.init()
				if (generation !== this.lifecycleGeneration) {
					// stop() could not clean up this component until its initialization completed.
					this.stopComponent(component)
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
	 * @notice Starts the light client dependencies
	 * @dev Dependencies are started in the correct order
	 * @returns Promise that resolves when the service is started
	 */
	start(): Promise<void> {
		if (this.startPromise) return this.startPromise
		if (this.running) {
			this.logger.warn("Already running. Skipping start.")
			return Promise.resolve()
		}

		this.running = true
		const generation = this.lifecycleGeneration
		this.startPromise = Promise.resolve()
			.then(() => this.startServices(generation))
			.finally(() => {
				this.startPromise = undefined
			})
		return this.startPromise
	}

	private isCurrentStartup(generation: number): boolean {
		return this.running && generation === this.lifecycleGeneration
	}

	private async startServices(generation: number): Promise<void> {
		if (!this.isCurrentStartup(generation)) return
		try {
			await this.connectChainNotifications()
			if (!this.isCurrentStartup(generation)) return
			// Connect before startup or initial sync can fetch and publish events.
			this.unsubscribeFromEventCacheService = this.eventCacheService.subscribe((event) => {
				if (this.isCurrentStartup(generation) && event.account.toString() === this.account.toString()) {
					this.onLeafAppended(event)
				}
			})
			if (!this.initialized) await this.initialize(generation)
			if (!this.isCurrentStartup(generation)) return
			this.logger.log("Starting services...")
			for (const component of this.spinUpOrder) {
				try {
					await component.start()
				} finally {
					// A pending start may acquire resources after stop(), even if it then rejects.
					if (!this.isCurrentStartup(generation)) this.stopComponent(component)
				}
				if (!this.isCurrentStartup(generation)) return
			}
			// start syncing (blocking)
			try {
				await this.sync()
				if (!this.isCurrentStartup(generation)) return
			} catch (error) {
				this.logger.error(`Failed to sync light client: ${error}`)
				throw error
			}
		} catch (error) {
			this.logger.error(`Failed to start light client services: ${error}`)
			if (generation === this.lifecycleGeneration) this.stopInitializedComponents()
			throw error
		}

		this.logger.log("All services started successfully, and client is synced.")
	}

	/**
	 * @notice Stops the light client dependencies
	 * @dev Disconnects incoming events, then stops dependencies in reverse order of initialization
	 */
	stop(): void {
		// Invalidate even an init() whose first component is still pending.
		this.lifecycleGeneration++
		this.disconnectChain()
		if (!this.running && this.initializedComponents.length === 0) {
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
		const errors: Error[] = []
		this.running = false
		this.disconnectChain()
		const unsubscribe = this.unsubscribeFromEventCacheService
		this.unsubscribeFromEventCacheService = undefined
		try {
			unsubscribe?.()
		} catch (error) {
			this.logger.error(`Error unsubscribing from event cache: ${error}`)
			errors.push(error instanceof Error ? error : new Error(String(error)))
		}
		// A failed storage init must not trigger stop(), which could persist an empty store.
		for (const component of this.initializedComponents.splice(0).reverse()) {
			const error = this.stopComponent(component)
			if (error) errors.push(error)
		}

		this.initialized = false
		return errors
	}

	private stopComponent(component: LifecycleComponent): Error | undefined {
		try {
			component.stop()
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			this.logger.error(`Error stopping component ${component.constructor?.name ?? ""}: ${msg}`)
			return error instanceof Error ? error : new Error(msg)
		}
		return undefined
	}
}
