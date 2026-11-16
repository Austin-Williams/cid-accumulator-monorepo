# CID Accumulator Client

Universal JavaScript/TypeScript client for interacting with smart contracts that implement the CIDAccumulator pattern.

## Overview

The CID Accumulator Client is off-chain code for fetching and verifying data for users of the CIDAccumulatorSingleton contract on Ethereum. It provides a light client, ideal for retrieving data (for example, in a browser UI or lightweight Node.js application). It also offers a "seeder" client (Node.js only) that can be kept running to pin all the accumulator's payload data to IPFS.

## Requirements

- **Light Client**: Works in both modern browsers and Node.js (26.13.1 or later).
- **Seeder**: Requires Node.js (26.13.1 or later) and a running IPFS node (IPFS Desktop recommended).

## Installation

```bash
npm install cid-accumulator-client
```

## Light Client

The light client retrieves all payload data for a single Ethereum address. It can be used in a browser or lightweight Node.js application.

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

// Get the ith payload as a hex string (without the 0x prefix)
const payloadHexString = await client.getPayload(i)

// Get the payloads in the range [i, j] as hex strings
const payloadsHexStringArray = await client.getPayloadInRange(i, j)

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

// Subscribe to new leaf events
const unsubscribe = client.subscribe((newLeaf) => {
  console.log(`New leaf appended: index ${newLeaf.leafIndex}`)
})
// When you no longer need the subscription
unsubscribe()

// =============
//    CLEANUP
// =============

// Later, when you're done
await client.stop();
```

When you call `client.start()`, the light client will:
- Retrieve the account's latest root CID from the accumulator contract and attempt to resolve it via the IPFS gateway.
- If it resolves the root CID, it is fully synced and ready to go!
- Otherwise, it will fetch the previous event via the Ethereum RPC to compute the prior root CID and attempt to resolve it via the IPFS gateway.
- It will continue "walking backwards" through prior root CIDs until it can resolve one via the IPFS gateway (or until it fully syncs from events).
- Once fully synced, it will poll for new events to stay updated and notify any subscribers.

Most light client users are not expected to run their own Ethereum node; instead, they will likely use a free-tier public RPC provider (e.g., Infura, Alchemy) and a public IPFS gateway (e.g., dweb.link). With that in mind, the client has been optimized to minimize the number and "weight" of RPC calls made to Ethereum and IPFS gateways. It also includes built-in rate limiting with automatic back-off and retries to prevent being blocked by public RPCs and gateways.

The light client is highly configurable via an optional `config` parameter. The example below shows the default configuration. Any or all of the options can be customized to suit your needs.

```typescript
import { createLightClient } from 'cid-accumulator-client'

const config = {
  dbPath: "./db/cid-accumulator-light-client.json",
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
    gatewayUrl: "https://dweb.link"
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

## Seeder

The Seeder is responsible for pinning accumulator data to IPFS. Anyone can run a seeder, and there is no need to trust a seeder.

Accumulator data will not be available via IPFS unless someone pins it. This is similar to how seeders are necessary in BitTorrent. At least one person needs to collect the data from the CIDAccumulatorSingleton contract events and pin them to IPFS (ideally, many people will run seeders). You do not need to trust the seeders because they cannot alter the contents of the data.

If you do not want to write your own seeder code, you can use the `Seeder` class from this repo, which handles everything for you.

### Requirements

- Node.js v26.13.1 or later. The root `.nvmrc` selects v26.13.1 for development.
- An IPFS node. The easiest way is to install [IPFS Desktop](https://docs.ipfs.tech/install/ipfs-desktop/) and start it. The default settings are fine.
- An Ethereum node. Ideally, you would run your own node, but a **private** (API-key protected) RPC provider (such as Infura or Alchemy) also works, even on their free tiers. **Do not** use a free-tier **public** RPC for running a seeder.

The Seeder does not require much from the Ethereum RPC, but it does poll continually for new contract events. Free-tier public RPCs (like https://ethereum-rpc.publicnode.com) tend to block IP addresses when they detect long-term polling operations (even when rate-limited).

There are two ways to run a seeder.

### Run a seeder from command line

You can clone this repo and run the seeder from the command line with the default options:

```bash
git clone https://github.com/Austin-Williams/cid-accumulator-singleton.git
cd cid-accumulator-singleton
npm ci
npm run seeder --workspace cid-accumulator-client
```

Run `npm ci` from the repository root to install all workspace dependencies using the committed `package-lock.json`.

You can also run it with custom options. For example:

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
Pinning remotely is ideal for user UX and UI performance, but usually costs money, so we default to false.
--remotePin=false

Ethereum HTTP RPC URL
--ethereumHttpRpcUrl=http://127.0.0.1:8545

IPFS gateway URL
--ipfsGatewayUrl=http://127.0.0.1:8080

IPFS pinner base URL
--ipfsPinnerBaseUrl=http://127.0.0.1:5001/api/v0

Path to the database file
--dbPath=./db/cid-accumulator-seeder.json
```

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

You can also pass in a custom config to the seeder. The example below shows the default configuration. Any or all of the options can be customized to suit your needs.

```typescript
const config: SeederConfigUserInput = {
  dbPath: "./db/cid-accumulator-seeder.json",
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
  syncCheckIntervalMs: 60000 // how often to check on the status of remote pins
}

const seeder = await createSeeder(config)
await seeder.start()

// Later, when you're done
await seeder.stop()
```

## Contract Addresses

- Mainnet: `0x8fA8C72c306f736701B3FC27976fAd25413fF5bF`

## License

MIT
