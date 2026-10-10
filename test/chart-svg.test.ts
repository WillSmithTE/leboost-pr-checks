import { describe, expect, it } from 'vitest'
import { parseChartQuery, renderChartSvg } from '../docs/chart/chart-svg'
import { chartUrl } from '../src/chart'

const query = (url: string | null): URLSearchParams => new URL(url ?? 'https://x.invalid').searchParams

describe('reference chart renderer', () => {
	it('reads back what the action encodes', () => {
		const url = chartUrl({ metric: 'LCP', page: '/docs', series: [2410, null, 2384, 2455], current: 2994 })
		expect(parseChartQuery(query(url))).toEqual({ metric: 'LCP', page: '/docs', series: [2410, null, 2380, 2460], current: 2990 })
		const cls = chartUrl({ metric: 'CLS', page: '/', series: [0.002, 0.003, 0.002], current: null })
		expect(parseChartQuery(query(cls))).toEqual({ metric: 'CLS', page: '/', series: [0.002, 0.003, 0.002], current: null })
	})

	it('refuses malformed queries with a reason', () => {
		expect(parseChartQuery(new URLSearchParams('v=2&m=LCP&s=1.2.3'))).toBe('unsupported version')
		expect(parseChartQuery(new URLSearchParams('v=1&m=FID&s=1.2.3'))).toBe('unknown metric')
		expect(parseChartQuery(new URLSearchParams('v=1&m=LCP&s=1._.3'))).toBe('needs three points')
		expect(parseChartQuery(new URLSearchParams('v=1&m=LCP&s=1.2.-3'))).toBe('bad point')
		expect(parseChartQuery(new URLSearchParams('v=1&m=LCP&s=1.2.3&c=x'))).toBe('bad current value')
		expect(parseChartQuery(new URLSearchParams(`v=1&m=LCP&s=${Array(31).fill(1).join('.')}`))).toBe('too many points')
	})

	it('draws every case without NaN and escapes the page', () => {
		const cases = [
			{ metric: 'LCP' as const, page: '/<script>', series: [2400, 2410, null, 2390], current: 2990 },
			{ metric: 'TBT' as const, page: '/', series: [0, 0, 0], current: 0 },
			{ metric: 'CLS' as const, page: '/', series: [0.002, 0.002, 0.004], current: null },
			{ metric: 'LCP' as const, page: '/', series: [null, 2400, null, 2410, null, 2390], current: 1200 },
		]
		for (const c of cases) {
			const svg = renderChartSvg(c)
			expect(svg).not.toMatch(/NaN|Infinity|undefined/)
			expect(svg).not.toContain('<script>')
			expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="520" height="240"')).toBe(true)
		}
	})
})
