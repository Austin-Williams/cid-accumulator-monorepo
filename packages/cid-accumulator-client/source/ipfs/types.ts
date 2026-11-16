import type { CID } from "./CID.js"

export type DagCborEncodedData = Uint8Array & { __dagCborEncoded: true }

export type CIDDataPair = {
	cid: CID<unknown, 113, 18, 1>
	dagCborEncodedData: DagCborEncodedData
}

export type IpldNode =
	| Uint8Array // dag-cbor encoded payload itself
	| CID<unknown, 113, 18, 1> // CID of the payload
	| { L: CID<unknown, 113, 18, 1>; R: CID<unknown, 113, 18, 1> } // IPLD link node
