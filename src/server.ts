// Server time: plain GETs (no browser, no throttling) to each path on main and the PR, interleaved. New connections first
// to catch cold starts, then warm kept-alive connections for the judged Server row.
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { DEVICES, type DeviceName, SERVER_TIMEOUT_MS } from './config'
import { firstLine, joinUrl, type Log, roundOrder } from './run'

const DOCUMENT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

// The browser's user agent and accept header, so the server answers as it does for the page loads, then the extra headers.
export function serverRequestHeaders(device: DeviceName, extra: Record<string, string>): Record<string, string> {
	const headers: Record<string, string> = { 'user-agent': DEVICES[device].userAgent, accept: DOCUMENT_ACCEPT }
	for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value
	return headers
}

export interface ServerTiming {
	// Server-Timing `total;dur=`: the handler's own time, without network or connection setup.
	total: number | null
	// Server-Timing `db;dur=`, summed over every db entry.
	db: number | null
	// Server-Timing `db;count=`, or the number of db entries when there are several and none has a count.
	queries: number | null
	// Server-Timing `isolate;desc=cold` or `warm`: whether this request was the first one its server instance handled.
	isolate: 'cold' | 'warm' | null
}

export interface ServerSample extends ServerTiming {
	// Request sent to first response byte: connection setup excluded on a kept-alive connection, included on a new one.
	ttfb: number
}

// A failed request is null, kept in its round so main and PR pair up by index.
export type ServerLoad = ServerSample | null

export interface ServerSamples {
	// The measured requests on warm connections.
	base: ServerLoad[]
	head: ServerLoad[]
	failures: { base: string[]; head: string[] }
	// The requests before them (new connections, then the warm-up), kept to find cold starts.
	first?: { base: ServerLoad[]; head: ServerLoad[] }
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
	const out: ServerTiming = { total: null, db: null, queries: null, isolate: null }
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
		const desc = params.get('desc')?.toLowerCase()
		if (key === 'isolate' && out.isolate === null && (desc === 'cold' || desc === 'warm')) out.isolate = desc
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

const MAX_REDIRECTS = 5

// One GET on a new connection, as a first-time visitor makes it: time from the start to the first response byte,
// connection setup included, following redirects. A new connection is how a request lands on a cold server instance.
export function timeNewConnection(url: string, headers: Record<string, string>, timeoutMs = SERVER_TIMEOUT_MS): Promise<ServerSample> {
	const started = performance.now()
	const deadline = AbortSignal.timeout(timeoutMs)
	const get = (target: URL, hops: number): Promise<ServerSample> =>
		new Promise((resolve, reject) => {
			const send = target.protocol === 'https:' ? httpsRequest : httpRequest
			const req = send(target, { headers, agent: false, signal: deadline }, res => {
				const ttfb = performance.now() - started
				const status = res.statusCode ?? 0
				const location = res.headers.location
				res.resume()
				res.on('error', reject)
				res.on('end', () => {
					if (status >= 300 && status < 400 && location && hops < MAX_REDIRECTS) {
						get(new URL(location, target), hops + 1).then(resolve, reject)
					} else if (status < 200 || status >= 300) reject(new Error(`HTTP ${status}`))
					else {
						const timing = res.headers['server-timing']
						const header = Array.isArray(timing) ? timing.join(', ') : (timing ?? null)
						resolve({ ttfb: Math.round(ttfb * 10) / 10, ...parseServerTiming(header) })
					}
				})
			})
			req.on('error', reject)
			req.end()
		})
	return get(new URL(url), 0)
}

function logLine(s: ServerSample): string {
	const parts = [`${Math.round(s.ttfb)} ms`]
	if (s.isolate !== null) parts.push(s.isolate)
	if (s.total !== null) parts.push(`total ${Math.round(s.total)} ms`)
	if (s.db !== null) parts.push(`db ${Math.round(s.db)} ms`)
	if (s.queries !== null) parts.push(`${s.queries} queries`)
	return parts.join(', ')
}

// New-connection requests, then warm-up requests (both kept apart for cold starts, never tested), then the measured rounds,
// one request per side each, in alternating order.
export async function sampleServer({
	path,
	baseUrl,
	headUrl,
	samples,
	newConnections,
	warmUp,
	request,
	newConnection,
	log,
}: {
	path: string
	baseUrl: string
	headUrl: string
	samples: number
	newConnections: number
	warmUp: number
	request: ServerRequest
	newConnection: ServerRequest
	log: Log
}): Promise<ServerSamples> {
	const sides = [
		{ name: 'base', label: 'main', url: joinUrl(baseUrl, path) },
		{ name: 'head', label: 'PR', url: joinUrl(headUrl, path) },
	] as const
	const first: NonNullable<ServerSamples['first']> = { base: [], head: [] }
	const out: ServerSamples = { base: [], head: [], failures: { base: [], head: [] }, first }
	const phase = async (label: string, rounds: number, send: ServerRequest): Promise<void> => {
		const line: string[] = []
		for (let i = 0; i < rounds; i++) {
			for (const side of roundOrder(sides, i)) {
				const sample = await send(side.url).catch((err: unknown) => {
					line.push(`${side.label} failed (${firstLine(err)})`)
					return null
				})
				first[side.name].push(sample)
				if (sample) line.push(`${side.label} ${logLine(sample)}`)
			}
		}
		if (line.length > 0) log(`  ${path} server ${label}: ${line.join('; ')}`)
	}
	await phase('new connections', newConnections, newConnection)
	await phase('warm-up', warmUp, request)
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
