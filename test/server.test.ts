import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coldLimit, summariseServer } from '../src/report'
import { parseServerTiming, type ServerLoad, type ServerSample, sampleServer, timeNewConnection, timeRequest } from '../src/server'

const quiet = () => {}
const none = { total: null, db: null, queries: null, isolate: null }

describe('parseServerTiming', () => {
	it('reads total, db time, the db count and the isolate marker, ignoring other metrics', () => {
		expect(parseServerTiming('cache;desc="hit, warm", total;dur=123.4, db;dur=45.6;count=7;desc="D1", isolate;desc=cold')).toEqual({
			total: 123.4,
			db: 45.6,
			queries: 7,
			isolate: 'cold',
		})
		expect(parseServerTiming('isolate;desc="Warm"').isolate).toBe('warm')
		expect(parseServerTiming('isolate;desc=lukewarm, isolate').isolate).toBeNull()
	})

	it('sums one db entry per query and counts them when no entry has a count', () => {
		expect(parseServerTiming('db;dur=3, db;dur=5.5, db;dur=1.5')).toEqual({ ...none, db: 10, queries: 3 })
		// One entry without a count says nothing about how many queries ran.
		expect(parseServerTiming('DB;DUR=12')).toEqual({ ...none, db: 12 })
	})

	it('returns nulls for a missing, empty or malformed header', () => {
		expect(parseServerTiming(null)).toEqual(none)
		expect(parseServerTiming('')).toEqual(none)
		expect(parseServerTiming('total;dur=fast, db;dur=-4;count=x, ;;,')).toEqual(none)
		expect(parseServerTiming('total')).toEqual(none)
	})

	it('keeps quoted commas and semicolons inside a description', () => {
		expect(parseServerTiming('app;desc="a, b; c";dur=9, total;dur=40')).toEqual({ ...none, total: 40 })
	})
})

describe('sampleServer', () => {
	it('sends new-connection and warm-up requests first and keeps them apart, then alternates main and PR', async () => {
		const calls: string[] = []
		const send = (kind: string) => async (url: string): Promise<ServerSample> => {
			calls.push(`${kind}${url.includes('main') ? 'b' : 'h'}`)
			if (calls.length === 10) throw new Error('HTTP 502\nmore')
			return { ...none, ttfb: calls.length }
		}
		const out = await sampleServer({
			path: '/docs',
			baseUrl: 'https://main.test',
			headUrl: 'https://pr.test/',
			samples: 3,
			newConnections: 2,
			warmUp: 2,
			request: send('w'),
			newConnection: send('n'),
			log: quiet,
		})
		// New connections b h, h b; warm-up b h, h b; then rounds b h, h b, b h.
		expect(calls.join(' ')).toBe('nb nh nh nb wb wh wh wb wb wh wh wb wb wh')
		expect(out.first?.base.map(s => s?.ttfb ?? null)).toEqual([1, 4, 5, 8])
		expect(out.base.map(s => s?.ttfb ?? null)).toEqual([9, 12, 13])
		expect(out.head).toEqual([null, { ...none, ttfb: 11 }, { ...none, ttfb: 14 }])
		expect(out.failures).toEqual({ base: [], head: ['HTTP 502'] })
	})
})

describe('timeRequest and timeNewConnection', () => {
	let server: Server
	let origin = ''
	const connections = new Set<unknown>()
	beforeAll(async () => {
		server = createServer((req, res) => {
			const delay = req.url === '/slow' ? 150 : 0
			setTimeout(() => {
				if (req.url === '/missing') {
					res.writeHead(404).end('no')
					return
				}
				if (req.url === '/moved') {
					res.writeHead(302, { location: '/' }).end()
					return
				}
				res.writeHead(200, { 'content-type': 'text/html', 'server-timing': `total;dur=${delay + 2}, db;dur=1.5;count=2, isolate;desc=warm` })
				res.end(`<p>${req.headers['x-bypass'] ?? 'none'}</p>`)
			}, delay)
		})
		server.on('connection', socket => connections.add(socket))
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})
	afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

	it('times the first byte and reads Server-Timing', async () => {
		const fast = await timeRequest(`${origin}/`, {})
		const slow = await timeRequest(`${origin}/slow`, { 'x-bypass': 'yes' })
		expect(fast).toMatchObject({ total: 2, db: 1.5, queries: 2, isolate: 'warm' })
		expect(slow.total).toBe(152)
		// The server holds /slow for 150 ms; upper bounds stay loose for a busy test machine.
		expect(slow.ttfb).toBeGreaterThanOrEqual(145)
		expect(slow.ttfb).toBeLessThan(2000)
		expect(fast.ttfb).toBeGreaterThanOrEqual(0)
	})

	it('fails on an HTTP error, and on a timeout', async () => {
		await expect(timeRequest(`${origin}/missing`, {})).rejects.toThrow('HTTP 404')
		await expect(timeRequest(`${origin}/slow`, {}, 20)).rejects.toThrow()
		await expect(timeNewConnection(`${origin}/missing`, {})).rejects.toThrow('HTTP 404')
		await expect(timeNewConnection(`${origin}/slow`, {}, 20)).rejects.toThrow()
	})

	it('opens a new connection per request, follows redirects and reads Server-Timing', async () => {
		const before = connections.size
		const slow = await timeNewConnection(`${origin}/slow`, {})
		const moved = await timeNewConnection(`${origin}/moved`, {})
		expect(slow).toMatchObject({ total: 152, isolate: 'warm' })
		expect(slow.ttfb).toBeGreaterThanOrEqual(145)
		expect(moved.total).toBe(2)
		// One connection for /slow, two for the redirect and its target.
		expect(connections.size - before).toBe(3)
	})
})

const sample = (ttfb: number, total: number | null = null, db: number | null = null): ServerSample => ({ ...none, ttfb, total, db })
// 30 values a few ms apart around a centre.
const around = (centre: number, offset = 0): number[] => Array.from({ length: 30 }, (_, i) => centre + (((i * 7 + offset) % 11) - 5) * 2)
const side = (values: number[], withTotal = false): ServerLoad[] => values.map(v => sample(v, withTotal ? v - 30 : null))
const noFailures = { base: [], head: [] }

describe('coldLimit', () => {
	it('leaves out a few cold outliers and keeps a slow regime that is most of the side', () => {
		const warm = around(100)
		// Median 101 ms, so the cut-off is 101 + 300 ms (more than 3 x 101).
		expect(coldLimit([...warm.slice(0, 28), 1600, 2100])).toBe(401)
		// A quarter of the requests are slow: that is how this server behaves, so nothing is left out.
		expect(coldLimit([...warm.slice(0, 22), ...Array<number>(8).fill(1600)])).toBeNull()
		expect(coldLimit(warm)).toBeNull()
		expect(coldLimit([])).toBeNull()
	})
})

describe('summariseServer', () => {
	it('reports no change for the same server on both sides', () => {
		const result = summariseServer({ base: side(around(120)), head: side(around(120, 3)), failures: noFailures }, 0.05)
		expect(result?.summary.verdict).toBe('no-change')
		expect(result?.server?.source).toBe('ttfb')
	})

	it('flags 100 ms more server time, and tests Server-Timing total when every request carries it', () => {
		const result = summariseServer({ base: side(around(120), true), head: side(around(220, 3), true), failures: noFailures }, 0.05)
		expect(result?.server?.source).toBe('server-timing')
		expect(result?.summary).toMatchObject({ verdict: 'regressed', baseMedian: 90, headMedian: 190 })
		// The floor is 50 ms or 10% of main's median, whichever is larger.
		expect(result?.summary.floor).toBe(50)
	})

	it('falls back to the first byte when any request lacks a total', () => {
		const head = side(around(120, 3), true)
		head[4] = sample(118)
		const result = summariseServer({ base: side(around(120), true), head, failures: noFailures }, 0.05)
		expect(result?.server?.source).toBe('ttfb')
		expect(result?.summary.baseMedian).toBe(120)
	})

	it('without a marker, keeps cold outliers out of the test and lists them with slow first requests', () => {
		const base = around(120)
		base[0] = 1900
		base[9] = 2400
		const first = { base: side([2200, 130, 125]), head: side([140, 1800, 120]) }
		const result = summariseServer({ base: side(base), head: side(around(120, 3)), failures: noFailures, first }, 0.05)
		expect(result?.server?.coldStarts).toEqual({ source: 'outliers', base: [2200, 1900, 2400], head: [1800], requests: { base: 33, head: 33 } })
		expect(result?.base).toHaveLength(28)
		expect(result?.summary.verdict).toBe('no-change')
	})

	it('with the isolate marker, the server decides what was cold, however many', () => {
		const mark = (values: number[], cold: number[]): ServerLoad[] =>
			values.map((v, i) => ({ ...sample(v), isolate: cold.includes(i) ? 'cold' : 'warm' }))
		// Six cold requests among the measured ones: more than the outlier rule would leave out, and not slow enough for it.
		const base = mark(around(120), [0, 3, 6, 9, 12, 15])
		const first = { base: mark([900, 880, 125], [0, 1]), head: mark([1400, 130, 125], [0]) }
		const result = summariseServer({ base, head: mark(around(120, 3), []), failures: noFailures, first }, 0.05)
		expect(result?.server?.coldStarts.source).toBe('isolate')
		expect(result?.server?.coldStarts.base).toHaveLength(8)
		expect(result?.server?.coldStarts.head).toEqual([1400])
		expect(result?.base).toHaveLength(24)
	})

	it('needs 3 good requests per side', () => {
		const result = summariseServer({ base: [sample(100), null, sample(110)], head: side(around(100)), failures: { base: ['HTTP 500'], head: [] } }, 0.05)
		expect(result).toBeNull()
	})

	it('reports db time and queries from either side, and none for a static page without Server-Timing', () => {
		const base = side(around(120))
		const head = around(140).map(v => ({ ...sample(v, null, 40), queries: 9 }))
		const result = summariseServer({ base, head, failures: noFailures }, 0.05)
		expect(result?.server?.db).toEqual({ baseMedian: null, headMedian: 40 })
		expect(result?.server?.queries).toEqual({ baseMedian: null, headMedian: 9 })
		const stat = summariseServer({ base, head: side(around(120, 3)), failures: noFailures }, 0.05)
		expect(stat?.server?.db).toBeNull()
		expect(stat?.summary.verdict).toBe('no-change')
	})
})
