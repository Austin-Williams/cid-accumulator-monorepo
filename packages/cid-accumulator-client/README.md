# CID Accumulator Client

Universal JavaScript/TypeScript client for interacting with smart contracts that implement the CIDAccumulator pattern.

## Overview

The CID Accumulator Client is off-chain code for fetching and verifying data for users of contracts that inherit CIDAccumulator on Ethereum. It provides a light client, ideal for retrieving data (for example, in a browser UI or lightweight Node.js application). It also offers a "seeder" client (Node.js only) that can be kept running to pin all the accumulator's payload data to IPFS.

Replace `YOUR_CONTRACT_ADDRESS` in examples with your application's deployed contract address and configure the corresponding Ethereum RPC URL. For local development, deploy the contract to your local chain and use `http://127.0.0.1:8545`.

The client creates and verifies CIDv1 DAG-CBOR blocks using Keccak-256 (multihash code `0x1b`). Kubo uploads use `mhtype=keccak-256`.

## Requirements

- **Light Client**: Works in both modern browsers and Node.js (26.13.1 or later).
- **Seeder**: Requires Node.js (26.13.1 or later) and a running IPFS node (IPFS Desktop recommended).

## Installation

```bash
npm install cid-accumulator-client
```

## Light Client

The light client retrieves all payload data for a single application contract that inherits CIDAccumulator. It can be used in a browser or lightweight Node.js application. See [readAccumulator.ts](examples/readAccumulator.ts) for a runnable Node.js example.

```typescript
// =============
//    SETUP
// =============

import { createLightClient } from 'cid-accumulator-client'

// Create a light client for your application's accumulator
const client = await createLightClient({
  accumulatorContractConfig: {
    accumulatorContractAddress: 'YOUR_CONTRACT_ADDRESS', // Replace with your deployed contract address
  },
})

// Start the client and let it sync
await client.start()

// ===========================================
//    ACCESS DATA PAYLOADS ANY WAY YOU WANT
// ===========================================

// You can now access the payload data using the following methods

// Get the highest leaf index
const highestLeafIndexNumber = await client.getHighestIndex()

// Get the ith payload as a hex string (without the 0x prefix)
const i = 0
const payloadHexString = await client.getPayload(i)

// Get the available records from leaf index i through j, inclusive
const j = 10
const records = await client.getPayloadInRange(i, j)
for (const { index, payload } of records) {
  console.log(index, payload) // payload is hex without a 0x prefix
}

// Iterate over all payloads using the async iterator
for await (const { index, payload } of client.iterate()) {
  // Do something with the index and payload
  console.log(`Leaf ${index}: ${payload}`)
}

// Index payloads by their first 4 hex characters (2 bytes)
const payloadIndexMap = await client.createIndexByPayloadSlice(0, 4)
// Look up payloads whose first two bytes are 0xbeef
const matchingPayloadsArray = payloadIndexMap.get('beef')

// Download all payloads to a file
const downloadedFilePath = await client.downloadAllPayloads()

// Follow the tip, including replacement of unfinalized history.
const unsubscribe = client.subscribe((event) => {
  if (event.type === 'rollback') {
    // Remove your application's indexed leaves at and above this index.
    console.log(`Discard leaves from index ${event.firstInvalidLeafIndex}`)
    return
  }
  console.log(`New leaf appended: index ${event.record.leafIndex}`)
})
// When you no longer need the subscription
unsubscribe()

// =============
//    CLEANUP
// =============

// Later, when you're done
await client.stop();
```

With the default lazy event loading, a fresh light client syncs a seeded tree in two requests.

1. The client calls `getCIDAccumulatorState()` at `latest` and computes the root CID locally from the returned peaks.
2. It requests the root as a CAR from the IPFS gateway. Once it verifies the tree and leaf count, `start()` resolves and the payloads are ready to read. An empty tree or a verified local copy needs only the contract call.
3. If the gateway cannot supply the tree, the next request is `eth_getLogs` for the single block in `previousInsertBlockNumber`. The client uses the append event to reconstruct the previous root and repeats until it has every payload. Appends in the same block share a log request.

Live tracking begins at the next polling interval. It reconciles the initial snapshot with the current chain, delivers any intervening changes, and follows new appends. Setting `lazyLoadEvents: false` explicitly requests historical event indexing during startup.

Subscriptions deliver `append` and `rollback` events in order. A rollback invalidates the contract's leaves at and above `firstInvalidLeafIndex`; applications maintaining their own index must discard that suffix before applying subsequent appends. Consumers doing asynchronous indexing should process these notifications in order.

Subscriptions deliver live notifications. After starting or resuming a stopped client, await synchronization and initialize your application's index from the verified cached payloads. Another service sharing the database may already have repaired a reorganization while that client was stopped.

Live tracking uses the latest and finalized headers to detect reorganizations. It reads up to 256 ancestor hashes per simulated constructor `eth_call`, pinned to a known block hash. Providers that disable creation calls can supply individual headers instead. Live tracking also requires block-hash state and log queries and the `finalized` block tag. Recovery rewinds event discovery and the seeder's MMR.

The initial snapshot is verified against the root returned by the contract. The shared live index is scoped by chain ID and accumulator address. Before the client uses that index, it finishes any interrupted recovery and validates older caches that lack block-hash checkpoints. Services sharing a database coordinate recovery within one JavaScript context. Independently running processes or browser tabs should use separate database files or names.

Light clients can use a free-tier public Ethereum RPC provider (e.g., Infura, Alchemy) and a local or hosted IPFS HTTP gateway. With that in mind, the client has been optimized to minimize the number and "weight" of RPC calls made to Ethereum and IPFS gateways. It also includes built-in rate limiting with automatic back-off and retries to prevent being blocked by public RPCs and gateways.

The light client requires `config.accumulatorContractConfig.accumulatorContractAddress`. All other settings are optional. The example below shows their defaults; customize them to suit your deployment.

The default IPFS endpoint requires Kubo running locally. To use a hosted HTTP gateway, set `ipfsResolverConfig.gatewayUrl` to an endpoint that serves raw blocks and CAR responses. For manual browser access, use [inbrowser.link](https://inbrowser.link); it retrieves content through a browser service worker and cannot serve as this client's HTTP endpoint.

```typescript
import { createLightClient } from 'cid-accumulator-client'

const config = {
  nodeDbPath: "./db/cid-accumulator-light-client.json",
  browserDbName: "cid-accumulator",
  accumulatorContractConfig: {
    accumulatorContractAddress: "YOUR_CONTRACT_ADDRESS",
    ethereumHttpRpcUrl: "https://ethereum-rpc.publicnode.com",
    rateLimiterOptions: {
      intervalMs: 2000,
      maxRetries: 3,
      baseDelay: 1000,
      capDelay: 10000,
    },
  },
  eventCacheServiceConfig: {
    lazyLoadEvents: true,
    pollingIntervalMs: 12000,
  },
  ipfsResolverConfig: {
    gatewayUrl: "http://127.0.0.1:8080",
    rateLimiterOptions: {
      intervalMs: 200,
      maxRetries: 3,
      baseDelay: 500,
      capDelay: 10000,
    }
  }
}

const client = await createLightClient(config)
await client.start()

```

Both client factories accept separate storage settings for each environment:

- `nodeDbPath` selects the database file in Node.js.
- `browserDbName` selects the IndexedDB database in browsers. Its default is `cid-accumulator`. Clients on the same browser origin share storage when they use the same name.

The live account and event indexes use the RPC's chain ID and the application contract's address, so different chains and contracts can share a database. Different providers for the same chain and contract share those indexes. Light clients share verified IPFS blocks by CID.

## Seeder

The Seeder is responsible for pinning accumulator data to IPFS. Anyone can run a seeder, and there is no need to trust a seeder.

Accumulator data will not be available via IPFS unless someone pins it. This is similar to how seeders are necessary in BitTorrent. At least one person needs to collect the data from the application contract's events and pin them to IPFS (ideally, many people will run seeders). You do not need to trust the seeders because they cannot alter the contents of the data.

If you do not want to write your own seeder code, you can use the `Seeder` class from this repo, which handles everything for you.

### Requirements

- Node.js v26.13.1 or later. The root `.nvmrc` selects v26.13.1 for development.
- An IPFS node. The easiest way is to install [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) and start it. The default settings are fine.
- An Ethereum node. Ideally, you would run your own node, but a **private** (API-key protected) RPC provider (such as Infura or Alchemy) also works, even on their free tiers. **Do not** use a free-tier **public** RPC for running a seeder.

The Seeder does not require much from the Ethereum RPC, but it does poll continually for new contract events. Free-tier public RPCs (like https://ethereum-rpc.publicnode.com) tend to block IP addresses when they detect long-term polling operations (even when rate-limited).

There are two ways to run a seeder.

### Run a seeder from command line

You can clone this repo and run the seeder from the command line by specifying your deployed contract address:

```bash
git clone https://github.com/Austin-Williams/cid-accumulator-monorepo.git
cd cid-accumulator-monorepo
npm ci
npm run seeder --workspace cid-accumulator-client -- --accumulatorContractAddress=YOUR_CONTRACT_ADDRESS
```

Run `npm ci` from the repository root to install all workspace dependencies using the committed `package-lock.json`.

You can also run it with custom options. For example:

```bash
npm run seeder --workspace cid-accumulator-client -- --accumulatorContractAddress=YOUR_CONTRACT_ADDRESS --remotePin=true --ethereumHttpRpcUrl="https://mainnet.infura.io/v3/<YourInfuraApiKey>"
```

**Available options (contract address required; other defaults shown):**

```bash
The Ethereum address of your deployed accumulator contract (required)
--accumulatorContractAddress=YOUR_CONTRACT_ADDRESS

Enable remote pinning (set to true to pin all CIDs to all remote pinning services set up on your IPFS node).
Pinning remotely is ideal for user UX and UI performance, but usually costs money, so we default to false.
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

Each seeder follows one application contract. The Node database path is used as supplied; its cached data is separated by chain ID and contract address.

### Run a seeder programmatically

Another option is to run a seeder programmatically:


```typescript
import { createSeeder } from 'cid-accumulator-client';

// Create a seeder for your deployed accumulator contract
const seeder = await createSeeder({
  accumulatorContractConfig: {
    accumulatorContractAddress: 'YOUR_CONTRACT_ADDRESS', // Replace with your deployed contract address
  },
})

// Start the seeder. It will sync and pin all accumulator data to IPFS
await seeder.start()

// Later, when you're done
await seeder.stop()
```

The seeder requires `config.accumulatorContractConfig.accumulatorContractAddress`. The example below shows the defaults for all other settings, which can be customized to suit your deployment.

```typescript
import { createSeeder, type SeederConfigUserInput } from 'cid-accumulator-client'

const config: SeederConfigUserInput = {
  nodeDbPath: "./db/cid-accumulator-seeder.json",
  browserDbName: "cid-accumulator",
  accumulatorContractConfig: {
    accumulatorContractAddress: "YOUR_CONTRACT_ADDRESS",
    ethereumHttpRpcUrl: "http://127.0.0.1:8545",
    rateLimiterOptions: {
      intervalMs: 10,
      maxRetries: 5,
      baseDelay: 100,
      capDelay: 5000,
    },
  },
  eventCacheServiceConfig: {
    lazyLoadEvents: true,
    pollingIntervalMs: 5000,
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
  syncCheckIntervalMs: 60000 // how often to check the pinned accumulator against the current on-chain root
}

const seeder = await createSeeder(config)
await seeder.start()

// Later, when you're done
await seeder.stop()
```

## Contract Addresses

- Your application's mainnet deployment: `YOUR_CONTRACT_ADDRESS`

## License

MIT
