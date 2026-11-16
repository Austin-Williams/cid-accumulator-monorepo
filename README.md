# cid-accumulator

This code enables all smart contracts (and all EOAs) to append arbitrary data to their own "CID accumulator".

The CID accumulator trustlessly computes a CID (content identifier) that resolves over IPFS to a file containing **all data ever appended to their accumulator**.

Users can make a single ETH RPC call to the `getRootCIDString(address account) external view returns (string memory)` function to get an IPFS CID, and then make a single call to an IPFS HTTP gateway (e.g. a local Kubo gateway at `http://127.0.0.1:8080/ipfs/<CID>?format=car`) to acquire all data ever appended to their accumulator (as well as all additional data needed to locally verify that they have received the correct data).

It requires no trusted third parties or centralized services from start to finish. It is a fully decentralized system, completely aligned with cypherpunk values. It has no governance, no upgradability, no censorship, no unnecessary token, no "community", no non-profit "labs", no for-profit company, no rent-seeking, nothing. It is simply a free, open source tool to empower users.

## Table of Contents
- [Why we need it](#why-we-need-it)
- [How it works](#how-it-works)
- [How to use the smart contract](#how-to-use-the-smart-contract)
- [How the off-chain component works](#how-the-off-chain-component-works)
- [The Light Client](#the-light-client)
- [The Seeder](#the-seeder)
- [Gas Costs](#gas-costs)
- [How the CID is computed by the smart contract (for nerds)](#how-the-cid-is-computed-by-the-smart-contract-for-nerds)
- [Looking for a Maintainer](#looking-for-a-maintainer)
- [Contract address](#contract-address)


## Why we need it

Apps often emit on-chain events with data that users need later. For example, in privacy systems like Tornado Cash, Railgun, 0xbow, etc., users cannot withdraw their funds without having a local copy of the complete set of all historical deposit commitments for all users of the system. As another example, UniswapV4 has no on-chain index of what pools have been created. To find all pools that have been created, users need to acquire all initialization events ever emitted by the UniswapV4 contract. In both of these examples, gathering all this data from on-chain events can be completely impractical for users on free-tier RPCs (which almost all users rely on).

Typically, app developers rely on centralized services to provide the data directly to their users. This has a serious problem: when the centralized service goes offline or is forced to censor, most users can't use the app because they can't get the data they need (for example, to create the Merkle proof they need to withdraw funds from a privacy system, or to trade the coins they want to trade on UniswapV4). While the users could _in principle_ get the data they need from the blockchain, _in practice_ they often can't because that requires making far more RPC calls than the free-tier RPC providers allow.

Storing the data on IPFS solves half the problem -- it lets users get the data they need even when the centralized service goes offline. All they need is an IPFS CID (Content Identifier) for the data and they can fetch all the data they need from IPFS. But how can users learn what CID to use without having to rely on some trusted third party who could censor, lie, or go offline?

CID accumulators solve the second half of the problem by having _the smart contract itself_ compute and store an IPFS CID that points to a file containing all data ever appended to the account's accumulator. The contract maintains this CID as an accumulator, updating it each time your contract appends new data. Users can fetch everything they need directly from IPFS, with full confidence that they have the right CID — because _the smart contract itself_ computed it.

## How it works

A CID accumulator is simply a Merkle tree whose leaves are IPFS CIDs (content identifiers) of arbitrary binary data, and whose intermediate nodes are CIDs of IPLD-link objects that link to their children. That just means the data payload (your "file") is broken up into "blocks" and those blocks are used as the leaves in a Merkle tree -- with the only difference being that the nodes in the Merkle tree are not simple "hashes", but "multihashes", which is just a fancy name for "hashes with a few extra bytes prepended to indicate how the underlying data is encoded". So if you understand Merkle trees, you understand CID accumulators.

When you append a new data payload to a CID accumulator, you are simply appending a new "block" of data to your "file" (that is, appending a new leaf to your Merkle tree), and then computing the new "root hash" (or "root CID" in IPFS terms). It's as simple as that.

CID accumulators have the wonderful property that their root CID resolves over IPFS to a file containing all of the leaves' data.

In practice, this means that to get all the data payloads from IPFS, you need only make one call to an IPFS gateway, e.g.: `http://127.0.0.1:8080/ipfs/<rootCID>?format=car`. The response (assuming the gateway is able to find all the data via the IPFS DHT) is a CAR file that consists of all the payload data, as well as all the extra data you need to personally verify that you have received the correct data.

## How to use the smart contract

The canonical Solidity sources live in the root [`contracts/`](contracts/) directory: the [singleton contract](contracts/singleton/CIDAccumulatorSingleton.sol), its [libraries](contracts/libraries/), and the public [ICIDAccumulatorSingleton interface](contracts/interfaces/ICIDAccumulatorSingleton.sol). Make contract changes here and point Solidity build or test tooling at this directory.

```solidity
interface ICIDAccumulator { function appendLeaf(bytes calldata payload) external; }

contract YourContract {
  // Address of the CIDAccumulatorSingleton contract on Ethereum mainnet
  ICIDAccumulator private constant accumulator = ICIDAccumulator(0x8fA8C72c306f736701B3FC27976fAd25413fF5bF);

  function yourFunction() external {
    // Create any bytes payload you want (e.g., deposit commitment, pool initialization data, etc.)
    bytes memory payload = abi.encode("whatever data you want");

    // Append it to your accumulator
    accumulator.appendLeaf(payload);

   // That's it!
  }
}
```

The [CIDAccumulatorSingleton contract](https://etherscan.io/address/0x8fA8C72c306f736701B3FC27976fAd25413fF5bF#code) maintains a unique CID accumulator for every Ethereum address. Each accumulator is namespaced by `msg.sender` and is append-only. There is no need to "register", "initialize", or otherwise set up an accumulator. It is already there for you, ready for you to start throwing data at it via the `appendLeaf(bytes calldata payload)` function.

Each call to `appendLeaf` causes the accumulator contract to emit an event:

```solidity
event LeafAppended(
  // your account address
  address indexed account,
  // the index of the leaf that was appended to your account's accumulator
  uint256 leafIndex,
  // the block number of the previous insert for your accumulator (for efficient CID walkback)
  uint256 previousInsertBlockNumber,
  // the data that was appended
  bytes payload,
  // data needed to compute previous root CID from current root CID
  bytes32[] mergeLeftHashes
);
```

Most data inserts require between 14k and 23.3k gas for execution. See below for more about gas costs.

## How the off-chain component works

To get the root CID for your account's data, call either the `getRootCID(address account) external view returns (bytes memory rawCIDv1)` function (for the raw CIDv1 byte sequence) or the `getRootCIDString(address account) external view returns (string memory)` (for the base32-encoded CID string).

Then use that root CID to download the data from your IPFS HTTP gateway. For example, with Kubo running locally: `http://127.0.0.1:8080/ipfs/<rootCID>?format=car`.

To open a CID manually in a browser, use `https://inbrowser.link/ipfs/<rootCID>`. This gateway retrieves content through a browser service worker; programmatic clients need a local or hosted HTTP gateway.

But what if that CID is not available on IPFS?

The CIDAccumulatorSingleton contract is designed so you can efficiently compute the _previous_ root CID from the _current_ root CID plus the small amount of data emitted by the contract during the last data insert. This allows you to efficiently "walk back" from the current root CID through previous root CIDs until you find one that is resolvable via IPFS. Each 'step back' to an older root CID requires just one very lightweight ETH RPC call (no need to scan large ranges of blocks; you ask the RPC for a single event from a single specific block), and one call to the IPFS gateway to see if it can resolve the CID.

A nice feature of this CID walkback is that, once you find an older root CID that is available on IPFS, you'll have already collected all the data between it and the current root CID (because you gathered it as you "walked back"). So you'll be fully synced.

(In the worst case, if you never find any of the root CIDs on IPFS, you'll eventually walk all the way back to the contract deployment block. If that happens, you'll have fully synced using event data alone—with no help from IPFS. This worst case is equivalent to what all users normally face today when not using this CID Accumulator pattern and not using any trusted third parties.)

If you don't want to write all that off-chain code yourself, you can just use the `LightClient` class from this repo. It handles all of that for you.

## The Light Client

The light client is a lightweight, universal JS/TS class that works in modern browsers and Node.js (26.13.1 or later). It is intended to be used in decentralized UIs.

The light client:
- Collects and verifies all payload data for a single ethereum address.
- Stores the data in a local database (IndexedDB in the browser, or as a JSON file in Nodejs).
- Makes the payload data easy to access so you can use it in your UI.

### Installation

```bash
npm install cid-accumulator-client
```

### Usage

```typescript
// =============
//    SETUP
// =============

import { createLightClient } from 'cid-accumulator-client'

// Create a light client for a specific account
const client = await createLightClient('0xYourEthereumAddress')

// Start the client and let it sync
await client.start()

// ===========================================
//    ACCESS DATA PAYLOADS ANY WAY YOU WANT
// ===========================================

// You can now access the payload data using the following methods

// Get the highest leaf index
const highestLeafIndexNumber = await client.getHighestIndex()

// Get the ith payload as a hex string (no 0x prefix)
const payloadHexString = await client.getPayload(i)

// Get the payloads in the range [i, j] as hex strings
const payloadsHexStringArray = await client.getPayloadInRange(i, j)

// iterate over all payloads using the async iterator
for await (const { index, payload } of client.iterate()) {
  // do something with the index and payload
  console.log(`Leaf ${index}: ${payload}`)
}

// Index payloads by their first 4 hex characters (2 bytes)
const payloadIndexMap = await client.createIndexByPayloadSlice(0, 4)
// Look up payloads whose first two bytes are 0xbeef
const matchingPayloadsArray = payloadIndexMap.get('beef')

// Download all payloads to a file
const downloadedFilePath = await client.downloadAllPayloads()

// Subscribe to new LeafAppended events
const unsubscribe = client.subscribe((newLeaf) => {
  console.log(`New leaf appended: index ${newLeaf.leafIndex}`)
})
// When you no longer need the subscription
unsubscribe()

// =============
//    CLEANUP
// =============

// Later, when you're done
await client.stop()
```

On `client.start()`, the light client will:
- Get the account's latest root CID from the accumulator contract and attempt to resolve it via the IPFS gateway
- If it resolves the root CID then it is fully synced and ready to go!
- Otherwise it will fetch one past event via the ETH RPC to compute the prior root CID, and attempt to resolve it via the IPFS gateway.
- It will continue "walking backwards" through prior root CIDs until it can resolve one via the IPFS gateway (or else fully syncs from events).
- Once fully synced, it will poll for new events to stay updated and notify any subscribers.

Light clients can use a free-tier public Ethereum RPC provider (e.g., Infura, Alchemy, etc.) and a local or hosted IPFS HTTP gateway. With that in mind, the client has been optimized to minimize the number and "weight" of RPC calls made to the Ethereum RPCs and IPFS gateways. It also has built-in rate limiting with automatic backoff and retries to prevent getting blocked by the public RPCs and gateways.

### Configuration
The light client is highly configurable via an optional `config` parameter. The example below shows the default configuration. Any or all of the options can be changed to suit your needs.

The default IPFS endpoint requires Kubo running locally. To use a hosted HTTP gateway, set `ipfsResolverConfig.gatewayUrl` to an endpoint that serves raw blocks and CAR responses.

```typescript
import { createLightClient } from 'cid-accumulator-client'

const config = {
  nodeDbPath: "./db/cid-accumulator-light-client.json",
  browserDbName: "cid-accumulator",
  accumulatorContractConfig: {
    accumulatorContractAddress: "0x8fA8C72c306f736701B3FC27976fAd25413fF5bF"
    ethereumHttpRpcUrl: "https://ethereum-rpc.publicnode.com"
    rateLimiterOptions: {
      intervalMs: 2000,
      maxRetries: 3,
      baseDelay: 1000,
      capDelay: 10000,
    }
  }
  eventCacheServiceConfig: {
    lazyLoadEvents: true,
    pollingIntervalMs: 12000,
  }
  ipfsResolverConfig: {
    gatewayUrl: "http://127.0.0.1:8080"
    rateLimiterOptions: {
      intervalMs: 200,
      maxRetries: 3,
      baseDelay: 500,
      capDelay: 10000,
    }
  }
}

const client = await createLightClient("0xYourEthereumAddress", config)
await client.start()

```

Both client factories accept separate storage settings for each environment:

- `nodeDbPath` selects the database file in Node.js.
- `browserDbName` selects the IndexedDB database in browsers. Its default remains `cid-accumulator`, so existing browser caches continue to work. Clients on the same browser origin share storage when they use the same name; choose distinct names for different chains or accumulator contracts.

## The Seeder

The Seeder is what pins accumulator data to IPFS. Anyone can run a seeder, and nobody needs to trust a seeder.

Accumulator data will not be available via IPFS if nobody pins it. This is very similar to how seeders are necessary in BitTorrent. At least one person in the world needs to collect the data from the CIDAccumulatorSingleton contract events and pin it to IPFS. (Hopefully, many people will run seeders.) Nobody needs to trust the seeders because they cannot lie about the contents of the data.

If you don't want to write your own seeder code, you can use the `Seeder` class from this repo, which handles everything for you.

### Requirements

- Node.js v26.13.1 or later. The root `.nvmrc` selects v26.13.1 for development.

- An IPFS node. The easiest way is to install [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) and start it. Its default settings are fine.

- An Ethereum node. Ideally, you'd run your own node, but a **private** (i.e., requires an API key) RPC provider (like Infura, Alchemy, etc.) will work fine too, even on their free tiers. You should NOT use a free-tier **public** RPC for running a seeder.

The Seeder does not require much of the Ethereum RPC, but it does do continual polling for new contract events. Free-tier **public** RPCs (like https://ethereum-rpc.publicnode.com) tend to block IP addresses when they detect long term polling operations (even when they are rate-limited).

There are two ways to run a seeder.

### Run a seeder from command line

You can clone this repo and run the seeder from the command line with the default options.

```bash
git clone https://github.com/Austin-Williams/cid-accumulator-singleton.git
cd cid-accumulator-singleton
npm ci
npm run seeder --workspace cid-accumulator-client
```

Run `npm ci` from the repository root to install all workspace dependencies using the committed `package-lock.json`.

You can also run it with custom options. E.g.:

```bash
npm run seeder --workspace cid-accumulator-client -- --remotePin=true --ethereumHttpRpcUrl=https://mainnet.infura.io/v3/<YourInfuraApiKey>
```

**Available options (defaults shown):**

```bash
The Ethereum address of the accumulator contract
--accumulatorContractAddress=0x8fA8C72c306f736701B3FC27976fAd25413fF5bF

JSON array of Ethereum addresses to track (leave empty to pin for all accounts)
--specificAccountsOnly='[]'

Enable remote pinning (set to true to pin all CIDs to all remote pinning services set up on your IPFS node).
Remote pinning is ideal for user UX and UI performance, but it usually costs money, so the default is false.
--remotePin=false

Ethereum HTTP RPC URL
--ethereumHttpRpcUrl=http://127.0.0.1:8545

IPFS gateway URL
--ipfsGatewayUrl=http://127.0.0.1:8080

IPFS pinner base URL
--ipfsPinnerBaseUrl=http://127.0.0.1:5001/api/v0

Path to the Node database file
--nodeDbPath=./db/cid-accumulator-seeder.json
```

The seeder appends `-<accumulatorContractAddress>` to the Node database path.

### Run a seeder programmatically

Another option is to run a seeder programmatically:


```typescript
import { createSeeder } from 'cid-accumulator-client';

// Create a seeder with your Ethereum wallet
const seeder = await createSeeder()

// Start the seeder. It will sync and pin all accumulator data to IPFS
await seeder.start()

// Later, when you're done
await seeder.stop()
```

You can also pass in a custom config to the seeder. The example below shows the default configuration. Any or all of the options can be changed to suit your needs.

```typescript
const config: SeederConfigUserInput = {
  nodeDbPath: "./db/cid-accumulator-seeder.json",
  browserDbName: "cid-accumulator",
  accumulatorContractConfig: {
    accumulatorContractAddress: "0x8fA8C72c306f736701B3FC27976fAd25413fF5bF",
    ethereumHttpRpcUrl: "http://127.0.0.1:8545",
    rateLimiterOptions: {
      intervalMs: 10,
      maxRetries: 5,
      baseDelay: 100,
      capDelay: 5000,
    },
  },
  accountRegistryServiceConfig: {
    specificAccountsOnly: [], // leave empty to pin for all accounts
    pollingIntervalMs: 12000,
    batchSize: 10000,
  },
  eventCacheServiceConfig: {
    lazyLoadEvents: true,
    pollingIntervalMs: 5000,
    specificAccountsOnly: [], // leave empty to pin for all accounts
  },
  ipfsResolverConfig: {
    gatewayUrl:  "http://127.0.0.1:8080",
    rateLimiterOptions: {
      intervalMs: 10,
      maxRetries: 5,
      baseDelay: 100,
      capDelay: 5000,
    },
  },
  ipfsPinnerConfig: {
    baseUrl: "http://127.0.0.1:5001/api/v0",
    remotePin: false, // set to true if you want to pin to your configured remote pinning services
    remotePinningServiceRateLimiterOptions: {
      intervalMs: 500,
      maxRetries: 3,
      baseDelay: 100,
      capDelay: 10000,},
  },
  syncCheckIntervalMs: 60000 // how often to check the status of remote pins
}

const seeder = await createSeeder(config)
await seeder.start()

// Later, when you're done
await seeder.stop()
```


## Gas Costs

The execution gas cost of `appendLeaf` depends on how many **merge steps** are triggered by that particular insert. Most inserts (75% of them) require zero or one peak update and are cheap (cheaper than a fresh SSTORE). Occasionally, an insert will trigger a chain of merges — and this is what increases gas (for that insert only). Gas estimations below assume a 32-byte payload, but the contract can handle arbitrary length bytes.

| Merge Depth | Description                      | **Approx Gas** |
| ----------- | -------------------------------- | -------------- |
| 0           | No merges (new peak at height 0) | ≈ 14.5k gas    |
| 1           | Merge with 1 peak  → height 1    | ≈ 19.2k gas    |
| 2           | Merge with 2 peaks → height 2    | ≈ 23.3k gas    |
| 3           | Merge with 3 peaks → height 3    | ≈ 27.4k gas    |
| 4           | Merge with 4 peaks → height 4    | ≈ 31.4k gas    |
| 5           | Merge with 5 peaks → height 5    | ≈ 35.5k gas    |
| 6           | Merge with 6 peaks → height 6    | ≈ 39.6k gas    |
| 7           | Merge with 7 peaks → height 7    | ≈ 43.7k gas    |
| 8           | Merge with 8 peaks → height 8    | ≈ 47.8k gas    |
| 9           | Merge with 9 peaks → height 9    | ≈ 51.9k gas    |
| 10          | Merge with 10 peaks → height 10  | ≈ 56.0k gas    |


> ℹ️ Most inserts (87.5%) fall in the **14.5K–23.3K gas** range. Deeper merges are **exponentially rare**:
>
> - Merge depth 3 happens once every 8 inserts
> - Merge depth 6 happens once every 64 inserts
> - Merge depth 9 happens once every 512 inserts

For example, if you insert `2^20` entries (just over 1 million), here’s how often each merge depth occurs:

| Merge Depth | Inserts (%) | **Approx Gas** |
| ----------- | ----------- | -------------- |
| 0           | 50.0%       | ≈ 14 .5 k      |
| 1           | 25.0%       | ≈ 19 .2 k      |
| 2           | 12.5%       | ≈ 23 .3 k      |
| 3           | 6.25%       | ≈ 27 .4 k      |
| 4           | 3.125%      | ≈ 31 .4 k      |
| 5           | 1.5625%     | ≈ 35 .5 k      |
| 6           | 0.78125%    | ≈ 39 .6 k      |
| 7           | 0.390625%   | ≈ 43 .7 k      |
| 8           | 0.1953125%  | ≈ 47 .8 k      |
| 9           | 0.09765625% | ≈ 51 .9 k      |
| 10          | 0.048828125%| ≈ 56 .0 k      |


> ✅ Even after a million inserts, **87.5%** of them will require **two or fewer merges**, keeping gas costs low and consistent.

So the gas cost is determined only by that insert’s merge activity — **not** by the total size of the data set.

The mean steady-state cost per insert is ≈ 18.7k gas.

Note: The very first time an address appends data to the accumulator, the execution cost is about 53k gas because two empty storage slots need to be unzeroed when initializing the account's accumulator.

## How the CID is computed by the smart contract (for nerds)

In IPFS, data can be structured as a [DAG of IPLD nodes](https://ipld.io/) serialized with [DAG-CBOR](https://ipld.io/docs/codecs/known/dag-cbor/), a deterministic CBOR subset supporting embedded CID links. That basically means the data payload is broken up into "blocks" and those blocks are used as the leaves in a Merkle tree—with the only difference being that the nodes in the Merkle tree are not simple "hashes", but "multihashes", which are just hashes with a few extra bytes of metadata prepended.

Raw data chunks (like deposit commitments) can be stored as leaves, while intermediate nodes encode references to child CIDs, forming a Merkle tree. The root CID can then be recursively resolved through these links, enabling full and verifiable reconstruction of the original data set. A user needs only the root CID to access the entire data set.

So the high-level idea is to store the leaf data (e.g., deposit commitments) as leaves in a Merkle tree, but instead of having the nodes of the Merkle tree be hashes of the child nodes, they are multihashes of the _(DAG-CBOR-encoded) IPLD links_ to the child nodes. This simply means that before hashing the left and right child inputs when computing a parent node, you first serialize the child inputs as a DAG-CBOR-encoded object (e.g., `{ left: <leftHash>, right: <rightHash> }`, where `<leftHash>` and `<rightHash>` are the hashes of the DAG-CBOR-encoded left and right child nodes, respectively). The DAG-CBOR encoding is handled by the `DagCborCIDEncoder` library, and the rest is handled by the `CIDAccumulator.mergeNodes` function.

IPFS can work with any DAG structure, and thus any shape of Merkle tree. For this project, gas efficiency is critical. When appending a new leaf to a Merkle tree in the EVM setting, each intermediate node update requires an SLOAD and at least one SSTORE. The number of SSTOREs varies depending on the chosen Merkle tree structure. So the Merkle tree structure we use here is a [Merkle Mountain Range](https://docs.grin.mw/wiki/chain-state/merkle-mountain-range/) (MMR) structure, which requires the minimal number of SLOADs and SSTOREs per leaf insertion.

To illustrate the difference in gas cost between using an MMR vs a typical balanced, binary Merkle tree, consider the following. Each new leaf insertion into a balanced binary Merkle tree requires `log₂(n)` SLOADs and `log₂(n)` SSTOREs, where n is the number of leaves. So for example, the 100kth leaf insertion would require 17 SLOADs (2100 gas each) and 17 SSTOREs (5000 gas each) operations, costing a total of 120,700 gas. (We are considering only the cost of SLOADs and SSTOREs here, not any other memory/compute overhead, which is approximately equal between the two examples).

By contrast, for an MMR, each new leaf insertion requires _exactly_ two SSTOREs, and _at most_ `log₂(n) + 1` SLOADs (one to load the metadata, and then one for each merge that occurs). Statistically, over 87% of inserts require three or fewer SLOADs (one to load the metadata, and two or fewer to load the peaks that are merged). So the gas cost for inserting a new leaf (when there are around 100k leaves, so we're comparing apples to apples) is _at most_ 47,800 gas, and is more typically 14.5k - 19.2k gas. (This assumes you're SSTORing to non-zero slots, which is the most common case).

To view the root CID for an MMR, you have to "bag the peaks" (merge them), which requires at most `log₂(n) + 1` SLOADs (one for the metadata and then one for each peak in the MMR). However, this only ever needs to be done off-chain, so the gas cost is not a concern there.

So the leaf insertions are stored in an MMR, the contract stores only the current peaks of the MMR, and then the "peak bagging" to get the root CID from the peaks is done off-chain.

## Looking for a Maintainer

I love prototyping and getting early working versions of things built, but I do not enjoy maintaining projects or continuing to work on them long after the prototype phase. This project deserves someone who can take it over and make the codebase more mature and robust.

If you are passionate about open source, decentralized systems, and want to take this project to the next level, please consider stepping in! I would love to see this project taken over by someone who wants to make it more robust and easy to use. Please fork it and make it great. If you would like help getting familiar with the codebase, I'd be happy to assist.

## Contract address

Ethereum mainnet:
[0x8fA8C72c306f736701B3FC27976fAd25413fF5bF](https://etherscan.io/address/0x8fA8C72c306f736701B3FC27976fAd25413fF5bF#code)

