import { EthereumAddress } from "../ethereum/EthereumAddress"
import type { DeepPartial } from "../types/common"

export interface AccountRegistryServiceConfigUserInput extends DeepPartial<AccountRegistryServiceConfig> {}

export interface AccountRegistryServiceConfig {
	specificAccountsOnly: EthereumAddress[]
	pollingIntervalMs: number
	batchSize: number
}
