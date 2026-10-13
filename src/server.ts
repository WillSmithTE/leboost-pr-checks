// Server time: plain GETs (no browser, no throttling) to each path on main and the PR, interleaved. New connections first
// to catch cold starts, then warm kept-alive connections for the judged Server row.
import { Agent as HttpAgent, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { DEVICES, type DeviceName, SERVER_PIN_ATTEMPTS, SERVER_TIMEOUT_MS } from './config'
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
	// Server-Timing `db;desc=`: where the database runs (a region or data centre), from the first db entry that names one.
	dbLocation: string | null
	// Server-Timing `isolate;desc=cold` or `warm`: whether this request was the first one its server instance handled.
	isolate: 'cold' | 'warm' | null
}

export interface ServerSample extends ServerTiming {
	// Request sent to first response byte: connection setup excluded on a kept-alive connection, included on a new one.
	ttfb: number
	// The CDN edge that answered (Cloudflare cf-ray, CloudFront x-amz-cf-pop, Vercel x-vercel-id); null when none says.
	edge?: string | null
}

const headerValue = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))

// A connection stays on one edge, and a far edge adds its distance to every database round trip the server makes.
export function edgeOf(headers: IncomingHttpHeaders): string | null {
	const ray = /-([A-Z]{3})$/.exec(headerValue(headers['cf-ray']).trim())
	if (ray) return ray[1]
	const pop = /^([A-Z]{3})\d/.exec(headerValue(headers['x-amz-cf-pop']).trim())
	if (pop) return pop[1]
	const vercel = /^([a-z]{3}\d)::/.exec(headerValue(headers['x-vercel-id']).trim())
	return vercel ? vercel[1] : null
}

// The edge most of these requests reached, or null when none says.
export function commonEdge(samples: readonly ServerLoad[]): string | null {
	const counts = new Map<string, number>()
	for (const s of samples) if (s?.edge) counts.set(s.edge, (counts.get(s.edge) ?? 0) + 1)
	let best: string | null = null
	for (const [edge, n] of counts) if (best === null || n > (counts.get(best) ?? 0)) best = edge
	return best
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
	const out: ServerTiming = { total: null, db: null, queries: null, dbLocation: null, isolate: null }
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
			// It goes into the comment, so only a short plain name.
			const where = params.get('desc')?.trim() ?? ''
			if (out.dbLocation === null && /^[\w .:-]{1,40}$/.test(where)) out.dbLocation = where
		}
	}
	out.db = dbDur
	out.queries = dbCount ?? (dbEntries > 1 ? dbEntries : null)
	return out
}

const MAX_REDIRECTS = 5

// One kept-alive connection per origin protocol; requests on it go one at a time.
export interface Connection {
	http: HttpAgent
	https: HttpsAgent
}

export const keptAliveConnection = (): Connection => ({
	http: new HttpAgent({ keepAlive: true, maxSockets: 1 }),
	https: new HttpsAgent({ keepAlive: true, maxSockets: 1 }),
})

export function closeConnection(connection: Connection): void {
	connection.http.destroy()
	connection.https.destroy()
}

// One GET, following redirects, to the first response byte. On a kept-alive connection the clock starts once the socket is
// connected, so setup is left out; on a new connection (null) it starts at once, as a first-time visitor waits.
export function timeGet(url: string, headers: Record<string, string>, connection: Connection | null, timeoutMs = SERVER_TIMEOUT_MS): Promise<ServerSample> {
	const deadline = AbortSignal.timeout(timeoutMs)
	let started: number | null = null
	const get = (target: URL, hops: number): Promise<ServerSample> =>
		new Promise((resolve, reject) => {
			const https = target.protocol === 'https:'
			const send = https ? httpsRequest : httpRequest
			const agent = connection === null ? false : https ? connection.https : connection.http
			const sentAt = performance.now()
			if (connection === null) started ??= sentAt
			const req = send(target, { headers, agent, signal: deadline }, res => {
				const ttfb = performance.now() - (started ?? sentAt)
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
						resolve({ ttfb: Math.round(ttfb * 10) / 10, edge: edgeOf(res.headers), ...parseServerTiming(header) })
					}
				})
			})
			req.on('error', reject)
			// A reused socket is ready now; a new one once connected (TLS included), so setup stays out of a warm time.
			req.on('socket', socket => {
				if (connection === null || started !== null) return
				if (!socket.connecting) started = performance.now()
				else socket.once(https ? 'secureConnect' : 'connect', () => (started ??= performance.now()))
			})
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
	if (s.dbLocation !== null) parts.push(`db in ${s.dbLocation}`)
	if (s.edge) parts.push(`via ${s.edge}`)
	return parts.join(', ')
}

// A request on one of a side's kept-alive connections, by index.
export type WarmRequest = (url: string, side: 'base' | 'head', connection: number) => Promise<ServerSample>

// A warm-up request on a kept-alive connection, reopened until it reaches the target edge (when the site names its edge).
export async function pinnedWarmUp(
	send: () => Promise<ServerSample>,
	reconnect: (() => void) | undefined,
	target: string | null,
	attempts = SERVER_PIN_ATTEMPTS,
	missed: (sample: ServerSample) => void = () => {},
): Promise<ServerSample> {
	let sample = await send()
	for (let tries = 1; reconnect && target && sample.edge && sample.edge !== target && tries < attempts; tries++) {
		missed(sample)
		reconnect()
		sample = await send()
	}
	return sample
}

// New-connection requests, then one warm-up request per kept-alive connection (both kept apart for cold starts, never
// tested), then the measured rounds: one request per side each, alternating, rotating over the connections so a side's
// samples spread over several server machines instead of the one a single connection lands on. With reconnect, each
// kept-alive connection is reopened until it reaches the edge most new connections reached, so both sides are measured
// through the same place.
export async function sampleServer({
	path,
	baseUrl,
	headUrl,
	samples,
	newConnections,
	connections,
	request,
	newConnection,
	reconnect,
	log,
}: {
	path: string
	baseUrl: string
	headUrl: string
	samples: number
	newConnections: number
	connections: number
	request: WarmRequest
	newConnection: ServerRequest
	reconnect?: (side: 'base' | 'head', connection: number) => void
	log: Log
}): Promise<ServerSamples> {
	const sides = [
		{ name: 'base', label: 'main', url: joinUrl(baseUrl, path) },
		{ name: 'head', label: 'PR', url: joinUrl(headUrl, path) },
	] as const
	const first: NonNullable<ServerSamples['first']> = { base: [], head: [] }
	const out: ServerSamples = { base: [], head: [], failures: { base: [], head: [] }, first }
	const phase = async (label: string, rounds: number, send: (url: string, side: 'base' | 'head', i: number) => Promise<ServerSample>): Promise<void> => {
		const line: string[] = []
		for (let i = 0; i < rounds; i++) {
			for (const side of roundOrder(sides, i)) {
				const sample = await send(side.url, side.name, i).catch((err: unknown) => {
					line.push(`${side.label} failed (${firstLine(err)})`)
					return null
				})
				first[side.name].push(sample)
				if (sample) line.push(`${side.label} ${logLine(sample)}`)
			}
		}
		if (line.length > 0) log(`  ${path} server ${label}: ${line.join('; ')}`)
	}
	await phase('new connections', newConnections, url => newConnection(url))
	const target = commonEdge([...first.base, ...first.head])
	await phase('warm-up', connections, (url, side, i) =>
		pinnedWarmUp(
			() => request(url, side, i),
			reconnect ? () => reconnect(side, i) : undefined,
			target,
			SERVER_PIN_ATTEMPTS,
			sample => first[side].push(sample),
		),
	)
	for (let round = 0; round < samples; round++) {
		const line: string[] = []
		for (const side of roundOrder(sides, round)) {
			try {
				const sample = await request(side.url, side.name, round % connections)
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
