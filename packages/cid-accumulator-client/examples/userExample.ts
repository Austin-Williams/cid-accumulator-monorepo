import { secrets } from "./secrets"
import { promptUserChoice } from "../source/utils/userPrompt"
import { JsonRpcProvider, Contract, Mnemonic, HDNodeWallet } from "ethers"
import { randomBytes } from "crypto"
import { CIDAccumulatorSingletonABI } from "../source/utils/constants"

import { promises as fs } from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

// Get directory name equivalent for ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function appendUserData(entry: any) {
	// Use __dirname that we defined above
	const userDataPath = path.resolve(__dirname, "userData.json")
	let data = []
	try {
		const file = await fs.readFile(userDataPath, "utf8")
		data = JSON.parse(file)
	} catch (err: any) {
		if (err.code !== "ENOENT") throw err
	}
	data.push(entry)
	await fs.writeFile(userDataPath, JSON.stringify(data, null, 2))
}

export async function main() {
	console.log("\n==== AVAILABLE WALLETS ====")

	// Create wallet addresses
	const wallets = []
	for (let i = 0; i < 6; i++) {
		const path = `m/44'/60'/0'/0/${i}`
		const wallet = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(secrets.seedPhrase), path)
		wallets.push(wallet)
		console.log(`Wallet ${i}: ${wallet.address}`)
	}
	console.log("==== END AVAILABLE WALLETS ====\n")

	// Let user choose which wallet to use
	const accountIndex = Number(await promptUserChoice("Choose account index (0-5): ", ["0", "1", "2", "3", "4", "5"]))

	// Get the selected wallet
	const derivedAccount = wallets[accountIndex]
	console.log(`\nUsing wallet ${accountIndex}: ${derivedAccount.address}`)

	// Create ethers Contract instance for CIDAccumulatorSingleton
	const provider = new JsonRpcProvider(secrets.ethereumHttpRpcUrl)
	const signer = derivedAccount.connect(provider)
	const accumulatorSingleton = new Contract(secrets.accumulatorContractAddress, CIDAccumulatorSingletonABI, signer)

	console.log("==== Ethereum Account ====")
	console.log("Address:", derivedAccount.address)

	// Prompt the user for the number of txs they want to send (between 1..100)
	const txChoices = Array.from({ length: 100 }, (_, i) => (i + 1).toString())
	const numTxsStr = await promptUserChoice("How many transactions do you want to send? (1-100): ", txChoices)
	const numTxs = Number(numTxsStr)
	console.log(`You chose to send ${numTxs} transaction${numTxs === 1 ? "" : "s"}.`)

	// Prompt the use for the number of seconds to wait between txs (1..600)
	const secondsBetweenTxsChoices = Array.from({ length: 600 }, (_, i) => (i + 1).toString())
	const secondsBetweenTxsStr = await promptUserChoice(
		"How many seconds do you want to wait between transactions? (1-600): ",
		secondsBetweenTxsChoices
	)
	const secondsBetweenTxs = Number(secondsBetweenTxsStr)
	console.log(
		`You chose to wait ${secondsBetweenTxs} second${secondsBetweenTxs === 1 ? "" : "s"} between transactions.`
	)

	// Prompt the user for confirmation to continue, they can pres CTRL+c to abort
	await promptUserChoice("Press enter to continue, or CTRL+c to exit", [], false)
	console.log("Starting...")

	for (let i = 0; i < numTxs; i++) {
		// Generate a random number `randLength` from 0..150
		const randLength = Math.floor(Math.random() * 151)
		// Generate random bytes of length randLength
		const bytes = randomBytes(randLength)
		//use the wallet to send the transaction
		const tx = await accumulatorSingleton.appendLeaves([bytes])
		console.log(`Transaction ${i + 1}: Sent ${randLength} random bytes:`, bytes.toString("hex"))
		//wait for the transaction to be mined
		await provider.waitForTransaction(tx.hash)

		// If the tx was successful, append it to our list of submitted data in ./userData.json
		await appendUserData({
			txHash: tx.hash,
			bytes: bytes.toString("hex"),
			length: randLength,
			timestamp: new Date().toISOString(),
		})
		console.log(`Transaction ${i + 1}: Mined`)
		// wait for the next transaction
		await new Promise((resolve) => setTimeout(resolve, secondsBetweenTxs * 1000))
	}
}

await main()
