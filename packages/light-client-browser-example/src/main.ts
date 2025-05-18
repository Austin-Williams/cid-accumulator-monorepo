import { createLightClient } from "cid-accumulator-client"

window.addEventListener("DOMContentLoaded", () => {
	const accountInput = document.getElementById("account-input") as HTMLInputElement
	const startButton = document.getElementById("start-button") as HTMLButtonElement
	const stopButton = document.getElementById("stop-button") as HTMLButtonElement

	startButton.addEventListener("click", async () => {
		const account = accountInput.value.trim()
		console.log("Tracking account:", account)
		let client = (window as any).client
		if (!client) {
			client = await createLightClient(account)
				; (window as any).client = client
			console.log("Light client created. Accessible via window.client")
		}
		client.start().catch((error: unknown) => {
			console.error("Failed to start light client:", error)
		})
	})

	stopButton.addEventListener("click", async () => {
		const client = (window as any).client
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
