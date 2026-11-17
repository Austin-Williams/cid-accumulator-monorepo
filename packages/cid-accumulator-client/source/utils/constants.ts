import { CID } from "../ipfs/CID.js"

// Canonical dag-cbor/keccak-256/CIDv1 null node CID
export const NULL_CID: CID<unknown, 113, 27, 1> = CID.parse(
	"bafyrwie3cmps4ofjp7zlyrzxhydka74mcppswcpj76ox7kfqhfxtfftfti"
)

// Read-only ABI inherited by each consuming application; appends use the application's own API.
export const CIDAccumulatorABI = [
	{
		anonymous: false,
		inputs: [
			{ indexed: false, internalType: "uint64", name: "metadata", type: "uint64" },
			{ indexed: false, internalType: "bytes", name: "payloadAndMergeHashes", type: "bytes" },
		],
		name: "LeafAppended",
		type: "event",
	},
	{
		inputs: [],
		name: "getMMRMetaBits",
		outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "getRootCID",
		outputs: [{ internalType: "bytes", name: "", type: "bytes" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "getRootCIDString",
		outputs: [{ internalType: "string", name: "", type: "string" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "getState",
		outputs: [
			{ internalType: "uint256", name: "", type: "uint256" },
			{ internalType: "bytes32[32]", name: "", type: "bytes32[32]" },
		],
		stateMutability: "view",
		type: "function",
	},
]

export const LEAF_APPENDED_EVENT_SIGNATURE = "LeafAppended(uint64,bytes)"
