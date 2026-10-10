// Extra request headers (a preview protection bypass and the like), sent only to the measured sites.
// One browser-level Fetch session sees every page, iframe and worker; nothing else is touched.
import type { Browser, CDPSession } from 'playwright-core'

interface RequestPaused {
	requestId: string
	request: { url: string; headers: Record<string, string> }
}

// Fetch patterns use Chrome's wildcard syntax, where '*', '?' and '\' are special.
export function originPattern(origin: string): string {
	return `${origin.replace(/[\\*?]/g, ch => `\\${ch}`)}/*`
}

// The request's own headers with the extra ones set, replacing any of the same name in any case.
export function withHeaders(request: Record<string, string>, extra: Record<string, string>): { name: string; value: string }[] {
	const names = new Set(Object.keys(extra).map(k => k.toLowerCase()))
	const kept = Object.entries(request).filter(([name]) => !names.has(name.toLowerCase()))
	return [...kept, ...Object.entries(extra)].map(([name, value]) => ({ name, value }))
}

export async function sendHeaders(browser: Browser, headers: Record<string, string>, origins: readonly string[]): Promise<void> {
	if (Object.keys(headers).length === 0 || origins.length === 0) return
	const session: CDPSession = await browser.newBrowserCDPSession()
	session.on('Fetch.requestPaused', ({ requestId, request }: RequestPaused) => {
		session.send('Fetch.continueRequest', { requestId, headers: withHeaders(request.headers, headers) }).catch(() => {
			// The page or context closed while the request was paused; nothing left to answer.
		})
	})
	const patterns = [...new Set(origins)].map(origin => ({ urlPattern: originPattern(origin), requestStage: 'Request' as const }))
	await session.send('Fetch.enable', { patterns })
}
