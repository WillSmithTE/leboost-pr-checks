import { describe, expect, it } from 'vitest'
import { parseChartQuery, renderChartSvg, yScale } from '../docs/chart/chart-svg'
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

	it('always draws two to four gridlines, three where a nice step allows', () => {
		const counts = new Map<number, number>()
		const bad: string[] = []
		for (const metric of ['LCP', 'TBT', 'Server', 'INP', 'CLS'] as const) {
			for (let i = 0; i < 400; i++) {
				const scale = metric === 'CLS' ? 0.001 : 1
				const base = (50 + ((i * 7919) % 6000)) * scale
				const spread = (1 + ((i * 104729) % 900)) * scale
				const values = [base, base + spread * 0.3, base + spread]
				const { ticks, lo, hi } = yScale(metric, values, base)
				const inside = ticks.every(t => t >= lo - 1e-9 && t <= hi + 1e-9)
				if (ticks.length < 2 || ticks.length > 4 || !inside) bad.push(`${metric} ${values.join(',')}: ${ticks.join(',')}`)
				counts.set(ticks.length, (counts.get(ticks.length) ?? 0) + 1)
			}
		}
		expect(bad).toEqual([])
		expect(counts.get(3) ?? 0).toBeGreaterThan(1000)
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
