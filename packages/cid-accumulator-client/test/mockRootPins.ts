import type { TestContext } from "node:test"
import type { IpfsPinner } from "../source/ipfs/IpfsPinner.js"

export function mockRootPins(t: TestContext, pinner: IpfsPinner) {
	const roots = new Set<string>()
	t.mock.method(pinner, "listRootPins", async () => ({ local: new Set(roots), all: new Set(roots) }))
	t.mock.method(pinner, "pinRoot", async (root: string) => { roots.add(root) })
	t.mock.method(pinner, "unpinRoot", async (root: string) => { roots.delete(root) })
	return roots
}
