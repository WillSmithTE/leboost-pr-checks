// Server time: plain GETs (no browser, no throttling) to each path on main and the PR, warm and interleaved.
import { SERVER_TIMEOUT_MS } from './config'
import { firstLine, joinUrl, type Log, roundOrder } from './run'

export interface ServerTiming {
	// Server-Timing `total;dur=`: the handler's own time, without network or connection setup.
	total: number | null
	// Server-Timing `db;dur=`, summed over every db entry.
	db: number | null
	// Server-Timing `db;count=`, or the number of db entries when there are several and none has a count.
	queries: number | null
}

export interface ServerSample extends ServerTiming {
	// Request sent to first response byte, connection setup excluded.
	ttfb: number
}

// A failed request is null, kept in its round so main and PR pair up by index.
export type ServerLoad = ServerSample | null

export interface ServerSamples {
	base: ServerLoad[]
	head: ServerLoad[]
	failures: { base: string[]; head: string[] }
}

export type ServerRequest = (url: string) => Promise<ServerSample>

// Splits on a separator outside double-quoted strings, which may hold commas and semicolons.
function splitOutside(value: string, separator: string): string[] {
	const parts: string[] = []
	let current = ''
	let quoted = false
	for (let i = 0; i < value.length; i++) {
		const ch = value[i]
		if (ch === '\\' && quoted && i + 1 < value.length) {
			current += ch + value[++i]
			continue
		}
		if (ch === '"') quoted = !quoted
		if (ch === separator && !quoted) {
			parts.push(current)
			current = ''
		} else current += ch
	}
	parts.push(current)
	return parts.map(p => p.trim()).filter(p => p.length > 0)
}

const unquote = (v: string): string => (v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v)

function nonNegative(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === '') return null
	const n = Number(raw)
	return Number.isFinite(n) && n >= 0 ? n : null
}

// Reads the metrics this action uses from a Server-Timing header (several headers arrive joined by commas).
export function parseServerTiming(header: string | null): ServerTiming {
	const out: ServerTiming = { total: null, db: null, queries: null }
	if (!header) return out
	let dbEntries = 0
	let dbDur: number | null = null
	let dbCount: number | null = null
	for (const metric of splitOutside(header, ',')) {
		const [name = '', ...rawParams] = splitOutside(metric, ';')
		const params = new Map<string, string>()
		for (const param of rawParams) {
			const at = param.indexOf('=')
			if (at > 0) params.set(param.slice(0, at).trim().toLowerCase(), unquote(param.slice(at + 1).trim()))
		}
		const dur = nonNegative(params.get('dur'))
		const key = name.toLowerCase()
		if (key === 'total' && out.total === null) out.total = dur
		if (key === 'db') {
			dbEntries++
			if (dur !== null) dbDur = (dbDur ?? 0) + dur
			const count = nonNegative(params.get('count'))
			if (count !== null) dbCount = (dbCount ?? 0) + count
		}
	}
	out.db = dbDur
	out.queries = dbCount ?? (dbEntries > 1 ? dbEntries : null)
	return out
}

const nextTick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

// One GET: first byte from Node's resource timing (requestStart to responseStart), so a new connection's
// setup is left out; the wall time to the headers if no entry was recorded.
export async function timeRequest(url: string, headers: Record<string, string>, timeoutMs = SERVER_TIMEOUT_MS): Promise<ServerSample> {
	performance.clearResourceTimings()
	const started = performance.now()
	const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
	const wall = performance.now() - started
	// Read to the end so the connection is free for the next request.
	await response.arrayBuffer()
	if (!response.ok) throw new Error(`HTTP ${response.status}`)
	await nextTick()
	const entry = performance
		.getEntriesByType('resource')
		.filter(e => e.name === url)
		.at(-1)
	const timing = entry instanceof PerformanceResourceTiming && entry.responseStart >= entry.requestStart && entry.requestStart > 0 ? entry : null
	const ttfb = timing ? timing.responseStart - timing.requestStart : wall
	return { ttfb: Math.round(ttfb * 10) / 10, ...parseServerTiming(response.headers.get('server-timing')) }
}

function logLine(s: ServerSample): string {
	const parts = [`${Math.round(s.ttfb)} ms`]
	if (s.total !== null) parts.push(`total ${Math.round(s.total)} ms`)
	if (s.db !== null) parts.push(`db ${Math.round(s.db)} ms`)
	if (s.queries !== null) parts.push(`${s.queries} queries`)
	return parts.join(', ')
}

// Warm-up requests per side (discarded), then rounds of one request per side in alternating order.
export async function sampleServer({
	path,
	baseUrl,
	headUrl,
	samples,
	warmUp,
	request,
	log,
}: {
	path: string
	baseUrl: string
	headUrl: string
	samples: number
	warmUp: number
	request: ServerRequest
	log: Log
}): Promise<ServerSamples> {
	const sides = [
		{ name: 'base', label: 'main', url: joinUrl(baseUrl, path) },
		{ name: 'head', label: 'PR', url: joinUrl(headUrl, path) },
	] as const
	const out: ServerSamples = { base: [], head: [], failures: { base: [], head: [] } }
	const warm: string[] = []
	for (let i = 0; i < warmUp; i++) {
		for (const side of roundOrder(sides, i)) {
			const result = await request(side.url).then(
				s => `${Math.round(s.ttfb)} ms`,
				(err: unknown) => `failed (${firstLine(err)})`,
			)
			warm.push(`${side.label} ${result}`)
		}
	}
	if (warm.length > 0) log(`  ${path} server warm-up: ${warm.join(', ')}`)
	for (let round = 0; round < samples; round++) {
		const line: string[] = []
		for (const side of roundOrder(sides, round)) {
			try {
				const sample = await request(side.url)
				out[side.name].push(sample)
				line.push(`${side.label} ${logLine(sample)}`)
			} catch (err) {
				const reason = firstLine(err)
				out[side.name].push(null)
				out.failures[side.name].push(reason)
				line.push(`${side.label} FAILED ${reason}`)
			}
		}
		log(`  ${path} server #${round + 1}: ${line.join('; ')}`)
	}
	return out
}
