import type { Storage } from "./interface.js"

/** Serializes short chain-state operations for adapters sharing a database in this process. */
export class StorageCoordinator {
	public generation = 0
	private pending: Promise<void> = Promise.resolve()

	/** Callers must not acquire this coordinator again from inside an operation. */
	run<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation)
		// An operation's failure reaches its caller without blocking subsequent operations.
		this.pending = result.then(
			() => {},
			() => {}
		)
		return result
	}
}

const coordinators = new WeakMap<object, StorageCoordinator>()

export async function getStorageCoordinator(storage: Storage): Promise<StorageCoordinator> {
	const identity = storage.getIdentity ? await storage.getIdentity() : storage
	let coordinator = coordinators.get(identity)
	if (!coordinator) {
		coordinator = new StorageCoordinator()
		coordinators.set(identity, coordinator)
	}
	return coordinator
}
