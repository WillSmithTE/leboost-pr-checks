import { describe, expect, it } from 'vitest'
import { chartAlt, chartImage, chartUrl, fromUnits, MAX_POINTS, MAX_URL_CHARS, toUnits } from '../src/chart'

const SERIES = [2410, 2380, null, 2455, 2402, 2399]

// What the usero.io renderer does with the query (docs/chart-spec.md).
function decode(url: string): { v: string; m: string; p: string; s: (number | null)[]; c: number | null } {
	const q = new URL(url).searchParams
	const s = (q.get('s') ?? '').split('.').map(x => (x === '_' ? null : Number(x)))
	const c = q.get('c')
	return { v: q.get('v') ?? '', m: q.get('m') ?? '', p: q.get('p') ?? '', s, c: c === null ? null : Number(c) }
}

describe('chartUrl', () => {
	it('encodes timings in tens of ms, missing runs as _, and this PR apart', () => {
		const url = chartUrl({ metric: 'LCP', page: '/pricing', series: SERIES, current: 2994 })
		expect(url).toBe('https://usero.io/pr-checks/chart.png?v=1&m=LCP&p=%2Fpricing&s=241.238._.246.240.240&c=299')
		expect(decode(url ?? '')).toEqual({ v: '1', m: 'LCP', p: '/pricing', s: [241, 238, null, 246, 240, 240], c: 299 })
	})

	it('encodes CLS in thousandths and clamps out-of-range values', () => {
		expect(chartUrl({ metric: 'CLS', page: '/', series: [0.002, 0.081, 0.0004], current: null })).toBe(
			'https://usero.io/pr-checks/chart.png?v=1&m=CLS&p=%2F&s=2.81.0',
		)
		expect(toUnits('TBT', -5)).toBe(0)
		expect(toUnits('LCP', 5_000_000)).toBe(99999)
		expect(fromUnits('LCP', 241)).toBe(2410)
	})

	it('needs three past runs with a value', () => {
		expect(chartUrl({ metric: 'LCP', page: '/', series: [2400, null, 2410], current: 2500 })).toBeNull()
		expect(chartUrl({ metric: 'LCP', page: '/', series: [], current: 2500 })).toBeNull()
		expect(chartImage({ metric: 'LCP', page: '/', series: [2400, 2410], current: 2500 })).toBeNull()
	})

	it('keeps the newest 30 runs and a page label of 60 characters', () => {
		const long = Array.from({ length: 50 }, (_, i) => 1000 + i * 10)
		const page = `/blog/${'a'.repeat(80)}`
		const { s, p } = decode(chartUrl({ metric: 'LCP', page, series: long, current: 1500 }) ?? '')
		expect(s).toHaveLength(MAX_POINTS)
		expect(s[MAX_POINTS - 1]).toBe(149)
		expect(p).toHaveLength(60)
		expect(p.endsWith('...')).toBe(true)
	})

	it('stays under the URL limit even with a long base URL', () => {
		const baseUrl = `https://charts.example.com/${'x'.repeat(1300)}`
		const url = chartUrl({ metric: 'LCP', page: '/', series: Array<number>(30).fill(123456), current: 1, baseUrl }) ?? ''
		expect(url.length).toBeLessThanOrEqual(MAX_URL_CHARS)
		expect(decode(url).s.length).toBeGreaterThanOrEqual(3)
	})

	it('stays well under the limit with 30 runs, the longest values and the longest page label', () => {
		const url = chartUrl({ metric: 'LCP', page: `/${'é'.repeat(80)}`, series: Array<number>(30).fill(999_999), current: 999_999 }) ?? ''
		expect(url.length).toBeLessThan(MAX_URL_CHARS)
	})
})

describe('chartAlt', () => {
	it('tells the chart in words', () => {
		expect(chartAlt({ metric: 'LCP', page: '/pricing', series: SERIES, current: 2994 })).toBe(
			"LCP on /pricing, main's last 6 runs ranged 2.38 s to 2.46 s, latest 2.40 s. This PR: 2.99 s.",
		)
		expect(chartAlt({ metric: 'TBT', page: '/', series: [120, 120, 120], current: null })).toBe("TBT on /, main's last 3 runs held at 120 ms.")
	})

	it('escapes the page in the image tag', () => {
		const img = chartImage({ metric: 'LCP', page: '/a"b<c>', series: [1000, 1000, 1000], current: 1000 }) ?? ''
		expect(img).toContain('alt="LCP on /a&quot;b&lt;c&gt;, ')
		expect(img).toContain('p=%2Fa%22b%3Cc%3E')
	})
})
