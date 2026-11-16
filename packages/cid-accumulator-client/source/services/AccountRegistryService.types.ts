import { EthereumAddress } from "../ethereum/EthereumAddress.js"
import type { DeepPartial } from "../types/common.js"

export interface AccountRegistryServiceConfigUserInput extends DeepPartial<AccountRegistryServiceConfig> {}

export interface AccountRegistryServiceConfig {
	specificAccountsOnly: EthereumAddress[]
	pollingIntervalMs: number
	batchSize: number
}
