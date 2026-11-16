// #!/usr/bin/env node

import { createSeeder } from "../source/core/seeder/createSeeder.js"
import { registerGracefulShutdown } from "../source/utils/gracefulShutdown.js"
import type { SeederConfigUserInput } from "../source/core/seeder/Seeder.types.js"
import { isNodeJs } from "../source/utils/envDetection.js"

export async function runSeeder() {
	if (!isNodeJs()) {
		console.log("Please run this in Node.js")
		return
	}

	const cliArgs = parseCliArgs()

	console.log("accumulatorContractAddress", cliArgs.accumulatorContractAddress)


	if (!cliArgs.accumulatorContractAddress) throw new Error("--accumulatorContractAddress is required")
	const customConfig: SeederConfigUserInput = {
		accumulatorContractConfig: { accumulatorContractAddress: cliArgs.accumulatorContractAddress },
	}
	if (cliArgs.nodeDbPath) {
		customConfig.nodeDbPath = cliArgs.nodeDbPath
	}
	if (cliArgs.specificAccountsOnly) {
		customConfig.accountRegistryServiceConfig = { ...customConfig.accountRegistryServiceConfig, specificAccountsOnly: cliArgs.specificAccountsOnly }
		customConfig.eventCacheServiceConfig = { ...customConfig.eventCacheServiceConfig, specificAccountsOnly: cliArgs.specificAccountsOnly }
	}
	if (cliArgs.remotePin) {
		customConfig.ipfsPinnerConfig = { ...customConfig.ipfsPinnerConfig, remotePin: cliArgs.remotePin }
	}
	if (cliArgs.ethereumHttpRpcUrl) {
		customConfig.accumulatorContractConfig = { ...customConfig.accumulatorContractConfig, ethereumHttpRpcUrl: cliArgs.ethereumHttpRpcUrl }
	}
	if (cliArgs.ipfsGatewayUrl) {
		customConfig.ipfsResolverConfig = { ...customConfig.ipfsResolverConfig, gatewayUrl: cliArgs.ipfsGatewayUrl }
	}
	if (cliArgs.ipfsPinnerBaseUrl) {
		customConfig.ipfsPinnerConfig = { ...customConfig.ipfsPinnerConfig, baseUrl: cliArgs.ipfsPinnerBaseUrl }
	}

	const seeder = await createSeeder(customConfig)
	await seeder.start()

	// Register shutdown handler for graceful termination
	registerGracefulShutdown(async () => {
		console.log("Shutting down seeder...")
		seeder.stop()
	})

	// Log that the seeder is running
	console.log("Seeder is running. Press Ctrl+C to stop.")

	// Create a never-resolving promise to keep the process running indefinitely
	return new Promise<void>(() => {
		// This promise intentionally never resolves
	})
}

// --- CLI ARGUMENT PARSING ---
// Supported args:
// --accumulatorContractAddress (required string)
// --specificAccountsOnly (JSON array of ethereum addresses)
// --remotePin (boolean)
// --ethereumHttpRpcUrl (string)
// --ipfsGatewayUrl (string)
// --ipfsPinnerBaseUrl (string)
// --nodeDbPath (string)

interface CliArgs {
	accumulatorContractAddress?: string
	specificAccountsOnly?: string[]
	remotePin?: boolean
	ethereumHttpRpcUrl?: string
	ipfsGatewayUrl?: string
	ipfsPinnerBaseUrl?: string
	nodeDbPath?: string
}

function parseCliArgs(): CliArgs {
	const args: CliArgs = {};
	for (let i = 2; i < process.argv.length; i++) {
		const arg = process.argv[i];

		// Handle --flag=value format
		if (arg.startsWith('--')) {
			const separatorIndex = arg.indexOf('=');
			const key = separatorIndex === -1 ? arg.slice(2) : arg.slice(2, separatorIndex);
			const value = separatorIndex === -1 ? undefined : arg.slice(separatorIndex + 1);

			switch (key) {
				case 'specificAccountsOnly':
					try {
						args.specificAccountsOnly = JSON.parse(value ?? process.argv[++i]);
					} catch {
						console.error('Invalid --specificAccountsOnly value. Must be a JSON array.');
						process.exit(1);
					}
					break;

				case 'accumulatorContractAddress':
					args.accumulatorContractAddress = value ?? process.argv[++i];
					break;

				case 'remotePin':
					const remotePinValue = value ?? process.argv[++i];
					args.remotePin = remotePinValue === 'true' || remotePinValue === '1';
					break;

				case 'ethereumHttpRpcUrl':
					args.ethereumHttpRpcUrl = value ?? process.argv[++i];
					break;

				case 'ipfsGatewayUrl':
					args.ipfsGatewayUrl = value ?? process.argv[++i];
					break;

				case 'ipfsPinnerBaseUrl':
					args.ipfsPinnerBaseUrl = value ?? process.argv[++i];
					break;

				case 'nodeDbPath':
					args.nodeDbPath = value ?? process.argv[++i];
					break;
			}
		}
	}
	return args;
}

await runSeeder()
