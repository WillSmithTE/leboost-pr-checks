// Browser-wide request interception: analytics hits answered with an empty 204, opted-in hosts blocked, and extra
// headers sent only to the measured sites. One browser-level Fetch session sees every page, iframe and worker.
import type { Browser, CDPSession } from 'playwright-core'

export interface InterceptRules {
	// Chrome URL wildcard patterns answered with an empty 204 before they leave the browser.
	stub: readonly string[]
	// Chrome URL wildcard patterns failed as blocked by the client.
	block: readonly string[]
	// Sent only to requests whose origin is in headerOrigins (preview protection bypass and the like).
	headers: Readonly<Record<string, string>>
	headerOrigins: readonly string[]
}

export interface InterceptStats {
	stubbed: number
	blocked: number
}

// Chrome's Fetch and blocking wildcard syntax: '*' is zero or more characters, '?' exactly one, '\' escapes.
export function wildcardToRegExp(pattern: string): RegExp {
	let source = ''
	for (let i = 0; i < pattern.length; i++) {
		const ch = pattern[i]
		if (ch === '\\' && i + 1 < pattern.length) source += escapeRegExp(pattern[++i])
		else if (ch === '*') source += '.*'
		else if (ch === '?') source += '.'
		else source += escapeRegExp(ch)
	}
	return new RegExp(`^${source}$`, 's')
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

// A bare host such as "cdn.example.com" blocks it and its subdomains; anything with '*' or '/' is a pattern as is.
export function hostToPatterns(entry: string): string[] {
	if (entry.includes('*') || entry.includes('/')) return [entry]
	return [`*://${entry}/*`, `*://*.${entry}/*`]
}

type Action = 'stub' | 'block' | 'headers'

export function classify(url: string, rules: InterceptRules, compiled = compile(rules)): Action | null {
	if (compiled.stub.some(re => re.test(url))) return 'stub'
	if (compiled.block.some(re => re.test(url))) return 'block'
	if (compiled.headerOrigins.length > 0 && compiled.headerOrigins.includes(originOf(url))) return 'headers'
	return null
}

function compile(rules: InterceptRules) {
	return {
		stub: rules.stub.map(wildcardToRegExp),
		block: rules.block.map(wildcardToRegExp),
		headerOrigins: Object.keys(rules.headers).length > 0 ? rules.headerOrigins : [],
	}
}

function originOf(url: string): string {
	try {
		return new URL(url).origin
	} catch {
		return ''
	}
}

const header = (headers: Record<string, string>, name: string): string | undefined =>
	Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1]

// CORS headers so a fetch() or XHR beacon resolves as a success instead of erroring and retrying.
function stubHeaders(requestHeaders: Record<string, string>): { name: string; value: string }[] {
	const origin = header(requestHeaders, 'origin')
	return [
		{ name: 'access-control-allow-origin', value: origin ?? '*' },
		...(origin ? [{ name: 'access-control-allow-credentials', value: 'true' }] : []),
		{ name: 'access-control-allow-methods', value: 'GET, POST, PUT, OPTIONS' },
		{ name: 'access-control-allow-headers', value: header(requestHeaders, 'access-control-request-headers') ?? '*' },
		{ name: 'access-control-max-age', value: '600' },
	]
}

interface RequestPaused {
	requestId: string
	request: { url: string; method: string; headers: Record<string, string> }
}

export async function installInterceptor(browser: Browser, rules: InterceptRules): Promise<InterceptStats> {
	const stats: InterceptStats = { stubbed: 0, blocked: 0 }
	const compiled = compile(rules)
	const patterns = [
		...rules.stub,
		...rules.block,
		...compiled.headerOrigins.map(origin => `${origin}/*`),
	].map(urlPattern => ({ urlPattern, requestStage: 'Request' as const }))
	if (patterns.length === 0) return stats

	const session: CDPSession = await browser.newBrowserCDPSession()
	session.on('Fetch.requestPaused', (event: RequestPaused) => {
		void respond(session, event, rules, compiled, stats)
	})
	await session.send('Fetch.enable', { patterns })
	return stats
}

async function respond(
	session: CDPSession,
	{ requestId, request }: RequestPaused,
	rules: InterceptRules,
	compiled: ReturnType<typeof compile>,
	stats: InterceptStats,
): Promise<void> {
	try {
		const action = classify(request.url, rules, compiled)
		if (action === 'stub') {
			stats.stubbed++
			await session.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: stubHeaders(request.headers) })
		} else if (action === 'block') {
			stats.blocked++
			await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
		} else if (action === 'headers') {
			const extra = new Set(Object.keys(rules.headers).map(k => k.toLowerCase()))
			const kept = Object.entries(request.headers).filter(([name]) => !extra.has(name.toLowerCase()))
			await session.send('Fetch.continueRequest', {
				requestId,
				headers: [...kept, ...Object.entries(rules.headers)].map(([name, value]) => ({ name, value })),
			})
		} else {
			await session.send('Fetch.continueRequest', { requestId })
		}
	} catch {
		// The page or context closed while the request was paused; nothing left to answer.
	}
}
