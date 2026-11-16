import { createLightClient, EthereumAddress } from "cid-accumulator-client"

window.addEventListener("DOMContentLoaded", () => {
	const contractInput = document.getElementById("contract-input") as HTMLInputElement
	const rpcInput = document.getElementById("rpc-input") as HTMLInputElement
	let clientContractAddress: string | undefined
	let clientRpcUrl: string | undefined
	const accountInput = document.getElementById("account-input") as HTMLInputElement
	const startButton = document.getElementById("start-button") as HTMLButtonElement
	const stopButton = document.getElementById("stop-button") as HTMLButtonElement
	const clientWindow = window as Window & { client?: Awaited<ReturnType<typeof createLightClient>> }

	startButton.addEventListener("click", async () => {
		if (startButton.disabled) return
		startButton.disabled = true
		try {
			const accumulatorContractAddress = new EthereumAddress(contractInput.value.trim())
			const ethereumHttpRpcUrl = rpcInput.value.trim()
			const account = new EthereumAddress(accountInput.value.trim())
			let client = clientWindow.client
			if (
				!client ||
				client.account.toString() !== account.toString() ||
				clientContractAddress !== accumulatorContractAddress.toString() ||
				clientRpcUrl !== ethereumHttpRpcUrl
			) {
				await client?.stop()
				client = await createLightClient(account, {
					accumulatorContractConfig: { accumulatorContractAddress, ethereumHttpRpcUrl },
				})
				clientContractAddress = accumulatorContractAddress.toString()
				clientRpcUrl = ethereumHttpRpcUrl
				clientWindow.client = client
				console.log("Light client created. Accessible via window.client")
			}
			console.log("Tracking account:", client.account.toString())
			await client.start()
		} catch (error: unknown) {
			console.error("Failed to start light client:", error)
		} finally {
			startButton.disabled = false
		}
	})

	stopButton.addEventListener("click", async () => {
		const client = clientWindow.client
		if (client) {
			try {
				await client.stop()
				console.log("Light client stopped")
			} catch (error: unknown) {
				console.error("Error stopping light client:", error)
			}
		} else {
			console.warn("No light client instance to stop")
		}
	})
})
