import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coldLimit, summariseServer } from '../src/report'
import {
	closeConnection,
	keptAliveConnection,
	parseServerTiming,
	type ServerLoad,
	type ServerSample,
	sampleServer,
	timeGet,
} from '../src/server'

const quiet = () => {}
const none = { total: null, db: null, queries: null, dbLocation: null, isolate: null }

describe('parseServerTiming', () => {
	it('reads total, db time, the db count and the isolate marker, ignoring other metrics', () => {
		expect(parseServerTiming('cache;desc="hit, warm", total;dur=123.4, db;dur=45.6;count=7;desc="D1", isolate;desc=cold')).toEqual({
			total: 123.4,
			db: 45.6,
			queries: 7,
			dbLocation: 'D1',
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

	it('reads where the database runs from the first db entry that names it, and only a short plain name', () => {
		expect(parseServerTiming('db;dur=40;count=5;desc=DFW, isolate;desc=warm').dbLocation).toBe('DFW')
		expect(parseServerTiming('db;dur=3, db;dur=5;desc="us-east-1", db;dur=1;desc=SJC').dbLocation).toBe('us-east-1')
		expect(parseServerTiming('db;dur=3;desc="<img src=x>"').dbLocation).toBeNull()
		expect(parseServerTiming('cache;desc=DFW, db;dur=3;desc=""').dbLocation).toBeNull()
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
	it('sends new-connection and one warm-up request per connection first, then alternates main and PR over the connections', async () => {
		const calls: string[] = []
		const record = (call: string): ServerSample => {
			calls.push(call)
			if (calls.length === 10) throw new Error('HTTP 502\nmore')
			return { ...none, ttfb: calls.length }
		}
		const out = await sampleServer({
			path: '/docs',
			baseUrl: 'https://main.test',
			headUrl: 'https://pr.test/',
			samples: 3,
			newConnections: 2,
			connections: 2,
			request: async (url, side, i) => record(`${side === 'base' ? 'b' : 'h'}${i}`),
			newConnection: async url => record(`n${url.includes('main') ? 'b' : 'h'}`),
			log: quiet,
		})
		// New connections b h, h b; warm-up on connections 0 and 1; then rounds on 0, 1, 0.
		expect(calls.join(' ')).toBe('nb nh nh nb b0 h0 h1 b1 b0 h0 h1 b1 b0 h0')
		expect(out.first?.base.map(s => s?.ttfb ?? null)).toEqual([1, 4, 5, 8])
		expect(out.base.map(s => s?.ttfb ?? null)).toEqual([9, 12, 13])
		expect(out.head).toEqual([null, { ...none, ttfb: 11 }, { ...none, ttfb: 14 }])
		expect(out.failures).toEqual({ base: [], head: ['HTTP 502'] })
	})
})

describe('timeGet', () => {
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

	it('keeps one connection alive, times the first byte and reads Server-Timing', async () => {
		const connection = keptAliveConnection()
		const before = connections.size
		try {
			const fast = await timeGet(`${origin}/`, {}, connection)
			const slow = await timeGet(`${origin}/slow`, { 'x-bypass': 'yes' }, connection)
			const moved = await timeGet(`${origin}/moved`, {}, connection)
			expect(fast).toMatchObject({ total: 2, db: 1.5, queries: 2, isolate: 'warm' })
			expect(slow.total).toBe(152)
			// The server holds /slow for 150 ms; upper bounds stay loose for a busy test machine.
			expect(slow.ttfb).toBeGreaterThanOrEqual(145)
			expect(slow.ttfb).toBeLessThan(2000)
			expect(fast.ttfb).toBeGreaterThanOrEqual(0)
			expect(moved.total).toBe(2)
			expect(connections.size - before).toBe(1)
		} finally {
			closeConnection(connection)
		}
	})

	it('fails on an HTTP error, and on a timeout', async () => {
		const connection = keptAliveConnection()
		try {
			await expect(timeGet(`${origin}/missing`, {}, connection)).rejects.toThrow('HTTP 404')
			await expect(timeGet(`${origin}/slow`, {}, connection, 20)).rejects.toThrow()
		} finally {
			closeConnection(connection)
		}
		await expect(timeGet(`${origin}/missing`, {}, null)).rejects.toThrow('HTTP 404')
		await expect(timeGet(`${origin}/slow`, {}, null, 20)).rejects.toThrow()
	})

	it('opens a new connection per request without one, follows redirects and reads Server-Timing', async () => {
		const before = connections.size
		const slow = await timeGet(`${origin}/slow`, {}, null)
		const moved = await timeGet(`${origin}/moved`, {}, null)
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
		// The floor is 75 ms or 10% of main's median, whichever is larger.
		expect(result?.summary.floor).toBe(75)
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
		expect(result?.server?.coldStarts).toEqual({
			source: { base: 'outliers', head: 'outliers' },
			base: [2200, 1900, 2400],
			head: [1800],
			requests: { base: 33, head: 33 },
		})
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
		expect(result?.server?.coldStarts.source).toEqual({ base: 'isolate', head: 'isolate' })
		expect(result?.server?.coldStarts.base).toHaveLength(8)
		expect(result?.server?.coldStarts.head).toEqual([1400])
		expect(result?.base).toHaveLength(24)
	})

	it('decides per side, so a main that does not send the marker yet still gets its slow requests counted as cold', () => {
		const head: ServerLoad[] = around(80, 3).map(v => ({ ...sample(v), isolate: 'warm' }))
		const firstHead: ServerLoad[] = [{ ...sample(1600), isolate: 'cold' }, { ...sample(170), isolate: 'warm' }]
		const base = around(120)
		base[5] = 2100
		const result = summariseServer({ base: side(base), head, failures: noFailures, first: { base: side([1900, 300]), head: firstHead } }, 0.05)
		expect(result?.server?.coldStarts).toMatchObject({ source: { base: 'outliers', head: 'isolate' }, base: [1900, 2100], head: [1600] })
		expect(result?.base).toHaveLength(29)
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

	it('does not judge server time when the two databases run in different places, and judges it when they share one', () => {
		const at = (values: number[], db: number, dbLocation: string | null): ServerLoad[] => values.map(v => ({ ...sample(v, null, db), queries: 5, dbLocation }))
		// The same 5 queries, 300 ms slower only because the PR's database is further away.
		const apart = summariseServer({ base: at(around(220), 55, 'DFW'), head: at(around(520, 3), 326, 'SJC'), failures: noFailures }, 0.05)
		expect(apart?.summary).toMatchObject({ verdict: 'no-change', baseMedian: 220, headMedian: 520 })
		expect(apart?.server?.dbLocation).toEqual({ base: 'DFW', head: 'SJC' })
		const together = summariseServer({ base: at(around(220), 55, 'DFW'), head: at(around(520, 3), 326, 'DFW'), failures: noFailures }, 0.05)
		expect(together?.summary.verdict).toBe('regressed')
		// One side that does not say yet (main deployed before it did) is judged as before.
		const oneSided = summariseServer({ base: at(around(220), 55, null), head: at(around(520, 3), 326, 'SJC'), failures: noFailures }, 0.05)
		expect(oneSided?.summary.verdict).toBe('regressed')
		expect(oneSided?.server?.dbLocation).toEqual({ base: null, head: 'SJC' })
		expect(summariseServer({ base: side(around(120)), head: side(around(120, 3)), failures: noFailures }, 0.05)?.server?.dbLocation).toBeNull()
	})
})
