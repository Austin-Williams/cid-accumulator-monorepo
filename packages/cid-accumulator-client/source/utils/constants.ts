import { CID } from "../ipfs/CID.js"

// Canonical dag-cbor/sha2-256/CIDv1 null node CID
export const NULL_CID: CID<unknown, 113, 18, 1> = CID.parse(
	"bafyreifqwkmiw256ojf2zws6tzjeonw6bpd5vza4i22ccpcq4hjv2ts7cm"
)

export const CIDAccumulatorSingletonABI = [
	{
		inputs: [
			{
				internalType: "bytes",
				name: "payload",
				type: "bytes",
			},
		],
		name: "appendLeaf",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "bytes[]",
				name: "payloadArr",
				type: "bytes[]",
			},
		],
		name: "appendLeaves",
		outputs: [],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [],
		stateMutability: "nonpayable",
		type: "constructor",
	},
	{
		inputs: [
			{
				internalType: "uint256",
				name: "len",
				type: "uint256",
			},
		],
		name: "CBORLengthOverflow",
		type: "error",
	},
	{
		inputs: [
			{
				internalType: "uint256",
				name: "actualSize",
				type: "uint256",
			},
		],
		name: "DataBlockTooLargeForIPFS",
		type: "error",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: true,
				internalType: "address",
				name: "account",
				type: "address",
			},
			{
				indexed: false,
				internalType: "uint256",
				name: "leafIndex",
				type: "uint256",
			},
			{
				indexed: false,
				internalType: "uint256",
				name: "previousInsertBlockNumber",
				type: "uint256",
			},
			{
				indexed: false,
				internalType: "bytes",
				name: "payload",
				type: "bytes",
			},
			{
				indexed: false,
				internalType: "bytes32[]",
				name: "mergeLeftHashes",
				type: "bytes32[]",
			},
		],
		name: "LeafAppended",
		type: "event",
	},
	{
		anonymous: false,
		inputs: [
			{
				indexed: false,
				internalType: "address",
				name: "account",
				type: "address",
			},
		],
		name: "NewAccountInitialized",
		type: "event",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "account",
				type: "address",
			},
		],
		name: "getMMRMetaBits",
		outputs: [
			{
				internalType: "uint256",
				name: "",
				type: "uint256",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "account",
				type: "address",
			},
		],
		name: "getRootCID",
		outputs: [
			{
				internalType: "bytes",
				name: "rawCIDv1",
				type: "bytes",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "account",
				type: "address",
			},
		],
		name: "getRootCIDString",
		outputs: [
			{
				internalType: "string",
				name: "",
				type: "string",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{
				internalType: "address",
				name: "account",
				type: "address",
			},
		],
		name: "getState",
		outputs: [
			{
				internalType: "uint256",
				name: "",
				type: "uint256",
			},
			{
				internalType: "bytes32[32]",
				name: "",
				type: "bytes32[32]",
			},
		],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [],
		name: "SINGLETON_BIRTHDAY_BLOCK_NUM",
		outputs: [
			{
				internalType: "uint256",
				name: "",
				type: "uint256",
			},
		],
		stateMutability: "view",
		type: "function",
	},
]

export const LEAF_APPENDED_EVENT_SIGNATURE = "LeafAppended(address,uint256,uint256,bytes,bytes32[])"
