import { DataClient } from "../dataClient/DataClient.js"
import { createLogger } from "../../utils/logging.js"
import { insertionLogs, resolveRootSnapshot, storeRootSnapshot } from "./rootSnapshot.js"
import { getLeafRecordFromNormalizedDataAppendedEvent, uint8ArrayToHexString } from "../../utils/codec.js"
import { ChainChangedError } from "../../services/ChainState.js"
import type { AccumulatorStorageAdapter } from "../../storage/adapters/AccumulatorStorageAdapter.js"
import type { LeafRecord } from "../../mmr/types.js"

import type { DataClientDependencies, RootSnapshot } from "../dataClient/DataClient.types.js"
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
	private rootRead?: Promise<void>
	private firstPoll?: Promise<void>
	private firstPollTimer?: ReturnType<typeof setTimeout>
	private rootController = new AbortController()
	private followingTip = false

	constructor(dependencies: DataClientDependencies, private readonly startup?: { storage: AccumulatorStorageAdapter; intervalMs: number }) {
		super(dependencies)
		this.spinUpOrder = [
			dependencies.storage,
			dependencies.accumulatorContract,
			dependencies.eventCacheService,
			dependencies.ipfsResolver,
		]
		this.logger = createLogger(`LightClient ${this.account.toString()}`)
	}

	override sync(): Promise<void> {
		if (!this.startup || this.followingTip) return super.sync()
		if (this.firstPoll) return this.firstPoll
		if (this.rootRead) return this.rootRead
		const generation = this.lifecycleGeneration
		const storage = this.startup.storage
		const signal = this.rootController.signal
		this.syncing = true
		this.completedInitialSync = false
		const read = (async () => {
			let state = await this.accumulatorContract.getCIDAccumulatorState()
			for (let attempt = 0; ; attempt++) {
				try {
					const result = await resolveRootSnapshot(state, this.ipfsResolver, storage, insertionLogs(this.accumulatorContract), signal, this.rootSnapshot)
					if (generation === this.lifecycleGeneration) {
						this.rootSnapshot = result
						this.completedInitialSync = true
					}
					return
				} catch (error) {
					if (signal.aborted) return
					if (attempt >= 2) throw error
					// A reorg can replace the numbered insertion block during walkback.
					const latest = await this.accumulatorContract.getCIDAccumulatorState()
					if (state.meta.leafCount === latest.meta.leafCount && state.meta.previousInsertBlockNumber === latest.meta.previousInsertBlockNumber &&
						state.peaks.length === latest.peaks.length && state.peaks.every((p, i) => p.cid.equals(latest.peaks[i].cid))) throw error
					state = latest
				}
			}
		})().finally(() => {
			if (this.rootRead === read) {
				this.rootRead = undefined
				this.syncing = false
			}
		})
		this.rootRead = read
		return read
	}

	// The first live poll bridges from the state returned by start() to a block-hash-pinned
	// snapshot. Subsequent polls use the regular event cursor and reorganization recovery.
	private scheduleFirstPoll(generation: number, baseline: RootSnapshot): void {
		this.firstPollTimer = setTimeout(() => {
			if (!this.isCurrentStartup(generation)) return
			const poll = this.beginLiveTracking(generation, baseline)
			this.firstPoll = poll
			return poll.catch(error => {
				if (!this.isCurrentStartup(generation)) return
				this.logger.warn(`Could not start live tracking, retrying at the next poll: ${error}`)
				this.scheduleFirstPoll(generation, baseline)
			}).finally(() => { if (this.firstPoll === poll) this.firstPoll = undefined })
		}, this.startup!.intervalMs)
	}

	private async beginLiveTracking(generation: number, previous: RootSnapshot): Promise<void> {
		await this.rootRead
		if (!this.isCurrentStartup(generation)) return
		const signal = this.rootController.signal
		const storage = this.startup!.storage
		const chain = await this.chain
		const tip = await chain.snapshot()
		const state = await this.accumulatorContract.getCIDAccumulatorState({ blockHash: tip.block.hash, requireCanonical: true })
		const getAppend = insertionLogs(this.accumulatorContract, async n =>
			n > tip.finalizedBlockNumber ? (await chain.getBlock(tip, n)).hash : undefined)
		const current = await resolveRootSnapshot(state, this.ipfsResolver, storage, getAppend, signal, this.rootSnapshot)
		let common = current === previous ? current.payloads.length : 0
		while (common < previous.payloads.length && common < current.payloads.length &&
			previous.payloads[common] === current.payloads[common]) common++

		const appends: LeafRecord[] = []
		let block = state.meta.previousInsertBlockNumber
		for (let i = current.payloads.length - 1; i >= common; i--) {
			signal.throwIfAborted()
			const event = await getAppend(block, i)
			if (uint8ArrayToHexString(event.payload) !== current.payloads[i]) throw new ChainChangedError()
			appends.push(getLeafRecordFromNormalizedDataAppendedEvent(event))
			block = event.previousInsertBlockNumber
		}
		appends.reverse()
		if (!this.isCurrentStartup(generation)) return
		await chain.ensureCanonical(tip)
		await chain.commit(tip, async () => {
			if (!this.isCurrentStartup(generation)) return
			const head = await storage.get("chain:head")
			if (!head || JSON.parse(head).hash !== tip.block.hash) throw new ChainChangedError()
			await chain.trackAccount(this.account, current.payloads.length, state.meta.previousInsertBlockNumber)
			await storeRootSnapshot(storage, this.account, current, appends)
			await storage.put("events:latestPolledBlock", String(tip.block.number))
			if (!this.isCurrentStartup(generation)) return
			await this.connectChainNotifications(chain)
			if (!this.isCurrentStartup(generation)) return
			this.rootSnapshot = undefined
			this.followingTip = true
			this.completedInitialSync = true
			if (common < previous.payloads.length) {
				this.notifySubscribers({ type: "rollback", account: this.account, firstInvalidLeafIndex: common, block: tip.block })
			}
			if (this.isCurrentStartup(generation)) this.eventCacheService.followFrom(tip.block.number, appends)
		})
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
		const pendingRootRead = this.rootRead
		try {
			if (!this.startup) await this.connectChainNotifications()
			if (!this.isCurrentStartup(generation)) return
			// Connect before startup or initial sync can fetch and publish events.
			this.unsubscribeFromEventCacheService = this.eventCacheService.subscribe((event) => {
				if (this.isCurrentStartup(generation) && event.account.toString() === this.account.toString()) {
					this.onDataAppended(event)
				}
			})
			if (!this.initialized) await this.initialize(generation)
			if (!this.isCurrentStartup(generation)) return
			this.logger.log("Starting services...")
			for (const component of this.spinUpOrder) {
				if (this.startup && component === this.eventCacheService) continue
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
				// A retained sync can belong to a stopped run and an older chain snapshot.
				if (this.syncing && !this.rootRead) {
					try { await (this.startup ? super.sync() : this.sync()) } catch { /* Retry with this run's fresh snapshot below. */ }
					if (!this.isCurrentStartup(generation)) return
				}
				if (!pendingRootRead) this.completedInitialSync = false
				await (pendingRootRead ?? this.sync())
				if (!this.isCurrentStartup(generation)) return
				if (this.startup) this.scheduleFirstPoll(generation, this.rootSnapshot!)
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
		this.rootController.abort()
		this.rootController = new AbortController()
		clearTimeout(this.firstPollTimer)
		this.firstPoll = undefined
		if (this.rootRead) this.syncing = false
		this.rootRead = undefined
		this.followingTip = false
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
