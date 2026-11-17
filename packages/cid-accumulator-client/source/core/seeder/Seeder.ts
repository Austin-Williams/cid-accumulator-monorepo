import { createLogger } from "../../utils/logging.js"
import type { LifecycleComponent } from "../../types/common.js"
import type { SeederDependencies } from "./Seeder.types.js"

/** Coordinates one accumulator's live client and IPFS pinning service. */
export class Seeder {
	public readonly spinUpOrder: LifecycleComponent[]
	public initialized = false
	public running = false
	private initializedComponents: LifecycleComponent[] = []
	private lifecycleGeneration = 0
	private startPromise?: Promise<void>
	private initPromise?: Promise<void>
	private logger = createLogger("Seeder")

	constructor(public readonly dependencies: SeederDependencies) {
		// The light client owns storage, Ethereum access, event polling, and IPFS resolution.
		this.spinUpOrder = [dependencies.dataClient, dependencies.pinningService]
	}

	async init(): Promise<void> {
		const generation = this.lifecycleGeneration
		if (!this.running && this.startPromise) {
			try { await this.startPromise } catch { /* A canceled run can fail during cleanup. */ }
			if (generation !== this.lifecycleGeneration) return
		}
		if (this.initPromise) await this.initPromise
		if (generation !== this.lifecycleGeneration || this.initialized) return
		this.initPromise = this.initialize(generation).finally(() => { this.initPromise = undefined })
		return this.initPromise
	}

	private async initialize(generation: number): Promise<void> {
		try {
			for (const component of this.spinUpOrder) {
				await component.init()
				if (generation !== this.lifecycleGeneration) {
					component.stop()
					return
				}
				this.initializedComponents.push(component)
			}
			this.initialized = true
		} catch (error) {
			if (generation === this.lifecycleGeneration) this.stopInitializedComponents()
			throw error
		}
	}

	start(): Promise<void> {
		if (this.startPromise) return this.startPromise
		if (this.running) return Promise.resolve()
		this.running = true
		const generation = this.lifecycleGeneration
		this.startPromise = Promise.resolve().then(() => this.startServices(generation)).finally(() => {
			this.startPromise = undefined
		})
		return this.startPromise
	}

	private async startServices(generation: number): Promise<void> {
		if (generation !== this.lifecycleGeneration) return
		try {
			if (!this.initialized) await this.init()
			if (generation !== this.lifecycleGeneration) return
			for (const component of this.spinUpOrder) {
				try {
					await component.start()
				} finally {
					if (generation !== this.lifecycleGeneration) component.stop()
				}
				if (generation !== this.lifecycleGeneration) return
			}
			this.logger.log("Seeder is synchronized and pinning its accumulator")
		} catch (error) {
			if (generation === this.lifecycleGeneration) this.stopInitializedComponents()
			throw error
		}
	}

	stop(): void {
		this.lifecycleGeneration++
		const errors = this.stopInitializedComponents()
		if (errors.length > 0) throw new Error(`Errors stopping seeder: ${errors.map(error => error.message).join("; ")}`)
	}

	private stopInitializedComponents(): Error[] {
		this.running = false
		this.initialized = false
		const errors: Error[] = []
		const components = this.initializedComponents.splice(0).reverse()
		// Stop an in-flight light-client initialization too; it cleans up only acquired resources.
		if (!components.includes(this.dependencies.dataClient)) components.push(this.dependencies.dataClient)
		for (const component of components) {
			try { component.stop() } catch (error) {
				errors.push(error instanceof Error ? error : new Error(String(error)))
			}
		}
		return errors
	}
}
