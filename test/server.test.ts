import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coldLimit, summariseServer } from '../src/report'
import { parseServerTiming, type ServerLoad, type ServerSample, sampleServer, timeRequest } from '../src/server'

const quiet = () => {}

describe('parseServerTiming', () => {
	it('reads total, db time and the db count, ignoring other metrics', () => {
		expect(parseServerTiming('cache;desc="hit, warm", total;dur=123.4, db;dur=45.6;count=7;desc="D1"')).toEqual({
			total: 123.4,
			db: 45.6,
			queries: 7,
		})
	})

	it('sums one db entry per query and counts them when no entry has a count', () => {
		expect(parseServerTiming('db;dur=3, db;dur=5.5, db;dur=1.5')).toEqual({ total: null, db: 10, queries: 3 })
		// One entry without a count says nothing about how many queries ran.
		expect(parseServerTiming('DB;DUR=12')).toEqual({ total: null, db: 12, queries: null })
	})

	it('returns nulls for a missing, empty or malformed header', () => {
		const none = { total: null, db: null, queries: null }
		expect(parseServerTiming(null)).toEqual(none)
		expect(parseServerTiming('')).toEqual(none)
		expect(parseServerTiming('total;dur=fast, db;dur=-4;count=x, ;;,')).toEqual({ total: null, db: null, queries: null })
		expect(parseServerTiming('total')).toEqual(none)
	})

	it('keeps quoted commas and semicolons inside a description', () => {
		expect(parseServerTiming('app;desc="a, b; c";dur=9, total;dur=40')).toEqual({ total: 40, db: null, queries: null })
	})
})

describe('sampleServer', () => {
	it('warms up each side, then alternates main and PR and keeps a failed request as null in its round', async () => {
		const calls: string[] = []
		const request = async (url: string): Promise<ServerSample> => {
			calls.push(url.includes('main') ? 'b' : 'h')
			if (calls.length === 6) throw new Error('HTTP 502\nmore')
			return { ttfb: calls.length, total: null, db: null, queries: null }
		}
		const out = await sampleServer({
			path: '/docs',
			baseUrl: 'https://main.test',
			headUrl: 'https://pr.test/',
			samples: 3,
			warmUp: 2,
			request,
			log: quiet,
		})
		// Warm-up b h, h b; then rounds b h, h b, b h.
		expect(calls.join('')).toBe('bhhbbhhbbh')
		expect(out.base.map(s => s?.ttfb ?? null)).toEqual([5, 8, 9])
		expect(out.head).toEqual([null, { ttfb: 7, total: null, db: null, queries: null }, { ttfb: 10, total: null, db: null, queries: null }])
		expect(out.failures).toEqual({ base: [], head: ['HTTP 502'] })
	})
})

describe('timeRequest', () => {
	let server: Server
	let origin = ''
	beforeAll(async () => {
		server = createServer((req, res) => {
			const delay = req.url === '/slow' ? 150 : 0
			setTimeout(() => {
				if (req.url === '/missing') {
					res.writeHead(404).end('no')
					return
				}
				res.writeHead(200, { 'content-type': 'text/html', 'server-timing': `total;dur=${delay + 2}, db;dur=1.5;count=2` })
				res.end(`<p>${req.headers['x-bypass'] ?? 'none'}</p>`)
			}, delay)
		})
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	})
	afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))

	it('times the first byte and reads Server-Timing', async () => {
		const fast = await timeRequest(`${origin}/`, {})
		const slow = await timeRequest(`${origin}/slow`, { 'x-bypass': 'yes' })
		expect(fast).toMatchObject({ total: 2, db: 1.5, queries: 2 })
		expect(slow.total).toBe(152)
		// The server holds /slow for 150 ms; upper bounds stay loose for a busy test machine.
		expect(slow.ttfb).toBeGreaterThanOrEqual(145)
		expect(slow.ttfb).toBeLessThan(2000)
		expect(fast.ttfb).toBeGreaterThanOrEqual(0)
	})

	it('fails on an HTTP error, and on a timeout', async () => {
		await expect(timeRequest(`${origin}/missing`, {})).rejects.toThrow('HTTP 404')
		await expect(timeRequest(`${origin}/slow`, {}, 20)).rejects.toThrow()
	})
})

const sample = (ttfb: number, total: number | null = null, db: number | null = null): ServerSample => ({ ttfb, total, db, queries: null })
// 30 values a few ms apart around a centre.
const around = (centre: number, offset = 0): number[] => Array.from({ length: 30 }, (_, i) => centre + (((i * 7 + offset) % 11) - 5) * 2)
const side = (values: number[], withTotal = false): ServerLoad[] => values.map(v => sample(v, withTotal ? v - 30 : null))

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
		const result = summariseServer({ base: side(around(120)), head: side(around(120, 3)), failures: { base: [], head: [] } }, 0.05)
		expect(result?.summary.verdict).toBe('no-change')
		expect(result?.server?.source).toBe('ttfb')
	})

	it('flags 100 ms more server time, and tests Server-Timing total when every request carries it', () => {
		const result = summariseServer({ base: side(around(120), true), head: side(around(220, 3), true), failures: { base: [], head: [] } }, 0.05)
		expect(result?.server?.source).toBe('server-timing')
		expect(result?.summary).toMatchObject({ verdict: 'regressed', baseMedian: 90, headMedian: 190 })
		// The floor is 50 ms or 10% of main's median, whichever is larger.
		expect(result?.summary.floor).toBe(50)
	})

	it('falls back to the first byte when any request lacks a total', () => {
		const head = side(around(120, 3), true)
		head[4] = sample(118)
		const result = summariseServer({ base: side(around(120), true), head, failures: { base: [], head: [] } }, 0.05)
		expect(result?.server?.source).toBe('ttfb')
		expect(result?.summary.baseMedian).toBe(120)
	})

	it('keeps cold outliers out of the test and the medians, and lists them', () => {
		const base = around(120)
		base[0] = 1900
		base[9] = 2400
		const result = summariseServer({ base: side(base), head: side(around(120, 3)), failures: { base: [], head: [] } }, 0.05)
		expect(result?.server?.cold).toEqual({ base: [1900, 2400], head: [] })
		expect(result?.base).toHaveLength(28)
		expect(result?.summary.verdict).toBe('no-change')
	})

	it('needs 3 good requests per side', () => {
		const result = summariseServer({ base: [sample(100), null, sample(110)], head: side(around(100)), failures: { base: ['HTTP 500'], head: [] } }, 0.05)
		expect(result).toBeNull()
	})

	it('reports db time and queries from either side', () => {
		const base = side(around(120))
		const head = around(140).map(v => ({ ...sample(v, null, 40), queries: 9 }))
		const result = summariseServer({ base, head, failures: { base: [], head: [] } }, 0.05)
		expect(result?.server?.db).toEqual({ baseMedian: null, headMedian: 40 })
		expect(result?.server?.queries).toEqual({ baseMedian: null, headMedian: 9 })
	})
})
