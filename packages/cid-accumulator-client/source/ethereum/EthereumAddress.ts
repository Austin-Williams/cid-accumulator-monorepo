/**
 * Type representing an Ethereum address
 * Ensures addresses are always normalized (lowercase)
 */
export class EthereumAddress {
	private readonly value: string

	constructor(address: string) {
		// Validate Ethereum address format
		if (!address.match(/^0x[0-9a-fA-F]{40}$/)) {
			throw new Error(`Invalid Ethereum address format: ${address}`)
		}
		// Normalize to lowercase
		this.value = address.toLowerCase()
	}

	/**
	 * Returns the normalized (lowercase) address string
	 */
	public toString(): string {
		return this.value
	}

	/**
	 * Creates an EthereumAddress from a string, with validation
	 */
	public static fromString(address: string): EthereumAddress {
		return new EthereumAddress(address)
	}
}
