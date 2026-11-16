/** Keep endpoint credentials out of transport errors before callers or retry queues log them. */
export async function fetchWithRedactedErrors(url: string, init?: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init)
	} catch (error) {
		const redact = (text: string): string => {
			// Exact replacement also handles malformed URLs containing unescaped spaces.
			const withoutInput = url ? text.split(url).join("[redacted URL]") : text
			return withoutInput.replace(/https?:\/\/\S+/gi, "[redacted URL]")
		}
		const isError = error instanceof Error || error instanceof DOMException
		const sanitized = new Error(redact(isError ? error.message : String(error)))
		if (isError) sanitized.name = redact(error.name)
		// The original stack, cause, and extra properties can also contain the URL.
		throw sanitized
	}
}
