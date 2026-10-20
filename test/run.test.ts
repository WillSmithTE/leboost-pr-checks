import { describe, expect, it } from 'vitest'
import { contextRounds, inPool, joinUrl, type Metrics, roundOrder, type Side, samplePage, warmUp } from '../src/run'

const sides: Side[] = [
	{ name: 'base', url: 'https://main.test' },
	{ name: 'head', url: 'https://pr.test/' },
	{ name: 'prod', url: 'https://prod.test' },
]
const [base, head, prod] = sides
const quiet = () => {}

describe('samplePage', () => {
	it('rotates the side order each round and keeps a failed load as null in its round', async () => {
		const calls: string[] = []
		const measure = async (url: string): Promise<Metrics> => {
			calls.push(url)
			if (url.startsWith('https://pr.test') && calls.length === 2) throw new Error('page.goto: Timeout\nCall log:\n  - navigating')
			return { LCP: calls.length }
		}
		const { samples, failures } = await samplePage({ page: { path: '/docs', interaction: null, prod: true }, sides, rounds: 3, measure, log: quiet })
		expect(calls.map(u => new URL(u).host[0])).toEqual(['m', 'p', 'p', 'p', 'p', 'm', 'p', 'm', 'p'])
		expect(calls[1]).toBe('https://pr.test/docs')
		expect(failures).toEqual({ base: [], head: ['page.goto: Timeout'], prod: [] })
		expect(samples.head).toEqual([null, { LCP: 4 }, { LCP: 9 }])
		expect(samples.base).toHaveLength(3)
	})

	it('loads a context side in only some rounds while main and PR keep alternating', async () => {
		const calls: string[] = []
		const measure = async (url: string): Promise<Metrics> => {
			calls.push(url.includes('main') ? 'b' : url.includes('prod') ? 'P' : 'h')
			return {}
		}
		const { samples } = await samplePage({
			page: { path: '/', interaction: null, prod: true },
			sides: [base, head, { ...prod, context: true }],
			rounds: 4,
			contextLoads: 2,
			measure,
			log: quiet,
		})
		// Prod joins rounds 1 and 3, in the first slot and then the middle one.
		expect(calls.join(' ')).toBe('b h P h b b h h P b')
		expect(samples.prod).toHaveLength(2)
		expect(samples.base).toHaveLength(4)
	})

	it('never loads the context side on a page outside prod-paths, and reports no prod samples or failures for it', async () => {
		const calls: string[] = []
		const measure = async (url: string): Promise<Metrics> => {
			calls.push(url)
			if (url.includes('prod')) throw new Error('HTTP 404')
			return {}
		}
		const { samples, failures } = await samplePage({
			page: { path: '/b/fieldnote', interaction: null, prod: false },
			sides: [base, head, { ...prod, context: true }],
			rounds: 4,
			contextLoads: 3,
			measure,
			log: quiet,
		})
		expect(calls.some(u => u.includes('prod'))).toBe(false)
		expect(calls).toHaveLength(8)
		expect(samples).toEqual({ base: [{}, {}, {}, {}], head: [{}, {}, {}, {}] })
		expect(failures).toEqual({ base: [], head: [] })
	})
})

describe('samplePage in parallel', () => {
	it('starts every side of a round together, in the rotated order, and pairs loads by round', async () => {
		const started: string[] = []
		let inFlight = 0
		let most = 0
		const measure = async (url: string): Promise<Metrics> => {
			const side = url.includes('main') ? 'b' : url.includes('prod') ? 'P' : 'h'
			started.push(side)
			inFlight++
			most = Math.max(most, inFlight)
			const n = started.length
			// Main finishes last, so results must not be pushed in finish order.
			await new Promise(r => setTimeout(r, side === 'b' ? 10 : 1))
			inFlight--
			if (side === 'h' && n === 2) throw new Error('HTTP 500')
			return { LCP: n }
		}
		const { samples, failures } = await samplePage({
			page: { path: '/', interaction: null, prod: true },
			sides: [base, head, { ...prod, context: true }],
			rounds: 4,
			contextLoads: 2,
			measure,
			log: quiet,
			parallel: true,
		})
		expect(started.join(' ')).toBe('b h P h b b h h P b')
		expect(most).toBe(3)
		expect(samples.head).toHaveLength(4)
		expect(samples.head[0]).toBeNull()
		expect(samples.base.map(m => m?.LCP)).toEqual([1, 5, 6, 10])
		expect(samples.prod).toHaveLength(2)
		expect(failures.head).toEqual(['HTTP 500'])
	})
})

describe('inPool', () => {
	it('keeps at most limit in flight and returns results in item order', async () => {
		let inFlight = 0
		let most = 0
		const out = await inPool([30, 5, 20, 1, 10], 2, async ms => {
			inFlight++
			most = Math.max(most, inFlight)
			await new Promise(r => setTimeout(r, ms))
			inFlight--
			return ms * 2
		})
		expect(out).toEqual([60, 10, 40, 2, 20])
		expect(most).toBe(2)
	})
})

describe('contextRounds', () => {
	it('spreads the loads evenly and caps them at the round count', () => {
		expect([...contextRounds(3, 8)]).toEqual([1, 4, 6])
		expect([...contextRounds(3, 3)]).toEqual([0, 1, 2])
		expect([...contextRounds(5, 2)]).toEqual([0, 1])
		expect(contextRounds(0, 10).size).toBe(0)
	})
})

describe('warmUp', () => {
	it('loads every side once and survives a failure', async () => {
		const calls: string[] = []
		const lines: string[] = []
		await warmUp({
			page: { path: '/', interaction: null, prod: true },
			sides,
			measure: async url => {
				calls.push(url)
				if (url.includes('prod')) throw new Error('HTTP 503')
				return {}
			},
			log: line => lines.push(line),
		})
		expect(calls).toEqual(['https://main.test/', 'https://pr.test/', 'https://prod.test/'])
		expect(lines).toEqual(['  warm-up prod failed: HTTP 503'])
	})
})

describe('helpers', () => {
	it('rotates side order every round', () => {
		expect([0, 1, 2].map(r => roundOrder(['a', 'b', 'c'], r).join(''))).toEqual(['abc', 'bca', 'cab'])
		expect([0, 1].map(r => roundOrder(['a', 'b'], r).join(''))).toEqual(['ab', 'ba'])
	})

	it('joins URLs keeping a path prefix', () => {
		expect(joinUrl('https://x.dev/', '/docs')).toBe('https://x.dev/docs')
		expect(joinUrl('https://x.dev/app', 'demo?play=1')).toBe('https://x.dev/app/demo?play=1')
	})
})
