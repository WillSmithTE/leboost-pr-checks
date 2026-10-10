import { describe, expect, it } from 'vitest'
import {
	type BuildInput,
	buildResult,
	commentTitle,
	countVerdicts,
	formatValue,
	type PageInput,
	renderComment,
	type RunResult,
	summarisePage,
	toUploadPayload,
} from '../src/report'
import type { Load, Metrics } from '../src/run'
import fixture from './fixtures/run.json'

const META: Omit<BuildInput, 'pages'> = { ...fixture.meta, config: { ...fixture.meta.config, device: 'mobile' } }
const FIXTURE_PAGES: PageInput[] = fixture.pages
const build = (overrides: Partial<BuildInput> = {}): RunResult =>
	buildResult({ ...META, pages: FIXTURE_PAGES, durationMs: 1000, generatedAt: '2026-10-09T00:00:00Z', ...overrides })

describe('buildResult', () => {
	const result = build()
	const [docs, home, checkout] = result.pages

	it('flags the LCP and CLS regressions and the FCP improvement', () => {
		expect(home.metrics.LCP?.summary.verdict).toBe('regressed')
		expect(home.metrics.CLS?.summary.verdict).toBe('regressed')
		expect(home.metrics.FCP?.summary.verdict).toBe('no-change')
		expect(docs.metrics.FCP?.summary.verdict).toBe('improved')
		expect(docs.metrics.TTFB?.summary.verdict).toBe('no-change')
	})

	it('compares against prod only where prod has enough samples', () => {
		expect(docs.metrics.FCP?.summary.vsProd?.verdict).toBe('regressed')
		expect(home.metrics.LCP?.summary.vsProd).toBeNull()
	})

	it('omits metrics without enough samples and never invents INP', () => {
		expect(checkout.metrics).toEqual({})
		expect(docs.metrics.INP).toBeUndefined()
		// A metric no load reported (INP without interact) is not "dropped", it was never measured.
		expect(docs.dropped).toEqual([])
	})

	it('counts verdicts for the outputs', () => {
		expect(countVerdicts(result)).toEqual({ regressions: 2, improvements: 2 })
	})
})

describe('toUploadPayload', () => {
	it('emits exactly the v1 contract fields', () => {
		const payload = toUploadPayload(build())
		expect(Object.keys(payload).sort()).toEqual(
			['baseSha', 'baseUrl', 'branch', 'ciRunUrl', 'config', 'headSha', 'headUrl', 'pages', 'prNumber', 'prodUrl', 'repo', 'version'].sort(),
		)
		const lcp = payload.pages[1].metrics.LCP
		expect(Object.keys(lcp ?? {}).sort()).toEqual(['base', 'head', 'prod', 'summary'])
		expect(Object.keys(lcp?.summary ?? {}).sort()).toEqual(
			['baseMedian', 'deltaPct', 'headMedian', 'pValue', 'shiftHigh', 'shiftLow', 'verdict', 'vsProd'].sort(),
		)
		expect(Object.keys(payload.pages[0].metrics.FCP?.summary.vsProd ?? {}).sort()).toEqual(
			['deltaPct', 'pValue', 'prodMedian', 'shiftHigh', 'shiftLow', 'verdict'].sort(),
		)
	})

	it('leaves out pages with nothing compared, which the contract would reject', () => {
		expect(toUploadPayload(build()).pages.map(p => p.path)).toEqual(['/docs', '/'])
	})

	it('leaves prod fields out entirely when no prod URL was given', () => {
		const pages = FIXTURE_PAGES.map(p => ({ ...p, loads: { base: p.loads.base, head: p.loads.head } }))
		const payload = toUploadPayload(build({ prodUrl: null, pages }))
		expect(payload.prodUrl).toBeNull()
		expect(payload.pages[0].metrics.FCP).not.toHaveProperty('prod')
		expect(payload.pages[0].metrics.FCP?.summary).not.toHaveProperty('vsProd')
	})
})

// Eight rounds (three prod loads) around a centre, a few % apart on timings, CLS fixed.
// A null leaves the metric out of that load.
const BASE_JITTER = [-0.03, 0.01, -0.01, 0.025, 0, 0.015, -0.02, 0.005]
const HEAD_JITTER = [0.03, -0.015, 0.045, 0, 0.02, 0.005, 0.025, -0.01]
const PROD_JITTER = [0.01, -0.02, 0.005]
type Centre = Record<'LCP' | 'FCP' | 'CLS' | 'TBT' | 'TTFB', number>
const loads = (centre: Centre, missing: Partial<Record<keyof Centre, number[]>> = {}, jitter = BASE_JITTER): Metrics[] =>
	jitter.map((j, i) => {
		const m: Metrics = {}
		for (const [k, v] of Object.entries(centre) as [keyof Centre, number][]) {
			m[k] = (missing[k] ?? []).includes(i) ? null : k === 'CLS' ? v : Math.round(v * (1 + j) * 10) / 10
		}
		return m
	})
const HOME: Centre = { LCP: 2400, FCP: 1800, CLS: 0.002, TBT: 280, TTFB: 195 }
const DOCS: Centre = { LCP: 2010, FCP: 1700, CLS: 0, TBT: 0, TTFB: 180 }
// Prod loads third-party tags the previews do not, so its TBT is far higher.
const PROD_HOME: Centre = { ...HOME, TBT: 740, TTFB: 130 }
const PROD_DOCS: Centre = { ...DOCS, TBT: 520, TTFB: 128 }
const LEBOOST_URL = 'https://leboost.tech/dashboard/shop.example.com/lab-runs/clx42run'

interface ScenarioOptions {
	home?: Centre
	docs?: Centre
	prod?: boolean
	missing?: Record<string, Partial<Record<keyof Centre, number[]>>>
	// Every PR load failed, as when the preview 500s.
	headDown?: boolean
	leboostUrl?: string | null
}

function scenario({ home = HOME, docs = DOCS, prod = true, missing = {}, headDown = false, leboostUrl = null }: ScenarioOptions): RunResult {
	const headFailures = headDown ? Array<string>(8).fill('HTTP 500') : []
	const page = (path: string, base: Centre, head: Centre, prodCentre: Centre): PageInput => {
		const headLoads: Load[] = headDown ? Array<Load>(8).fill(null) : loads(head, missing[path], HEAD_JITTER)
		if (!prod) return { path, loads: { base: loads(base), head: headLoads }, failures: { base: [], head: headFailures } }
		return {
			path,
			loads: { base: loads(base), head: headLoads, prod: loads(prodCentre, {}, PROD_JITTER) },
			failures: { base: [], head: headFailures, prod: [] },
		}
	}
	const result = build({
		prodUrl: prod ? 'https://shop.example.com' : null,
		prodLoads: prod ? 3 : null,
		config: { ...META.config, pairs: 8 },
		pages: [page('/', HOME, home, PROD_HOME), page('/docs', DOCS, docs, PROD_DOCS)],
	})
	result.meta.leboostUrl = leboostUrl
	return result
}

// A run where raw LCP on `/` went 5.14 s to 5.46 s, all but ~10 ms of it the PR preview's slower first byte.
// Offsets in ms per round; paint is LCP or FCP minus TTFB.
const TTFB_J = { base: [-30, 20, -10, 40, 0, 10, -20, 30], head: [10, -20, 30, 0, -30, 40, 20, -10], prod: [-10, 0, 10] }
const PAINT_J = { base: [15, -10, 5, -20, 25, 0, -5, 10], head: [-5, 20, 0, 10, -20, 25, -10, 5], prod: [10, -10, 0] }
const TBT_J = { base: [-20, 15, -5, 25, 5, -10, 30, -15], head: [5, -15, 25, -20, 30, -10, 15, -5], prod: [-30, 0, 30] }
type Side3 = 'base' | 'head' | 'prod'
interface ServerCentre {
	ttfb: number
	lcp: number
	fcp: number
	tbt: number
	cls: number
}
function serverSide(side: Side3, { ttfb, lcp, fcp, tbt, cls }: ServerCentre): Metrics[] {
	return TTFB_J[side].map((tj, i) => {
		const TTFB = ttfb + tj
		const pj = PAINT_J[side][i]
		return { TTFB, LCP: TTFB + lcp + pj, FCP: TTFB + fcp + pj, TBT: tbt + TBT_J[side][i], CLS: cls }
	})
}
function slowPreviewServer(): RunResult {
	const page = (path: string, sides: Record<Side3, ServerCentre>): PageInput => ({
		path,
		loads: { base: serverSide('base', sides.base), head: serverSide('head', sides.head), prod: serverSide('prod', sides.prod) },
		failures: { base: [], head: [], prod: [] },
	})
	return build({
		prodUrl: 'https://shop.example.com',
		prodLoads: 3,
		config: { ...META.config, pairs: 8 },
		pages: [
			page('/', {
				base: { ttfb: 1181, lcp: 3950, fcp: 2210, tbt: 445, cls: 0.002 },
				head: { ttfb: 1495, lcp: 3960, fcp: 2220, tbt: 459, cls: 0.002 },
				prod: { ttfb: 210, lcp: 3840, fcp: 2050, tbt: 790, cls: 0.002 },
			}),
			page('/docs', {
				base: { ttfb: 165, lcp: 2600, fcp: 2100, tbt: 120, cls: 0 },
				head: { ttfb: 163, lcp: 2605, fcp: 2098, tbt: 118, cls: 0 },
				prod: { ttfb: 140, lcp: 2550, fcp: 2050, tbt: 410, cls: 0 },
			}),
		],
	})
}

const SCENARIOS: Record<string, RunResult> = {
	clean: scenario({ leboostUrl: LEBOOST_URL }),
	'slow-preview-server': slowPreviewServer(),
	'one-regression': scenario({ home: { ...HOME, LCP: 2950 } }),
	mixed: (() => {
		const result = build()
		result.meta.leboostUrl = LEBOOST_URL
		return result
	})(),
	'missing-prod': scenario({ prod: false, docs: { ...DOCS, TBT: 80 }, leboostUrl: LEBOOST_URL }),
	'dropped-metric': scenario({ missing: { '/': { LCP: [0, 2, 3, 4, 5, 7] } } }),
	'not-compared': scenario({ prod: false, headDown: true }),
}

// Copy outside the table rules: no em dashes, double dashes or empty intensifiers.
const prose = (md: string): string =>
	md
		.split('\n')
		.filter(line => !line.startsWith('|---'))
		.join('\n')

// Plain spaces for readable assertions; the snapshots keep the real non-breaking ones.
const render = (result: RunResult, options = {}): string => renderComment(result, options).replaceAll(' ', ' ')

describe('renderComment', () => {
	for (const [name, result] of Object.entries(SCENARIOS)) {
		it(`matches the ${name} fixture`, async () => {
			await expect(renderComment(result)).toMatchFileSnapshot(`./fixtures/comments/${name}.md`)
		})
	}

	it('leads with the title, says it never fails the build and keeps to the copy rules', () => {
		for (const md of Object.values(SCENARIOS).map(r => render(r))) {
			expect(md.startsWith('### Lab web vitals: ')).toBe(true)
			expect(md).toContain('never fails the build')
			expect(prose(md)).not.toMatch(/—|--|genuinely|truly|simply|really/)
		}
	})

	it('answers a clean run in the title, says what it can miss and folds the table away', () => {
		const md = render(SCENARIOS.clean)
		expect(md).toContain('### Lab web vitals: no significant change vs main\n')
		expect(md).toContain('Nothing on `/` and `/docs` moved past run-to-run noise.')
		// The LCP floor: 5% of `/`'s 2.2 s after the first byte.
		expect(md).toContain('With 8 loads per side, smaller shifts can slip through, such as an LCP change under 110 ms.')
		expect(md).not.toMatch(/server time|server responded/)
		expect(md).toContain('<details>\n<summary>All metrics, significant changes in bold</summary>')
	})

	it('names each regression with page, metric and size, and opens the table', () => {
		const md = render(SCENARIOS['one-regression'])
		expect(md).toContain('### Lab web vitals: 1 regression vs main\n')
		expect(md).toMatch(/^- \*\*LCP\*\* on `\/`: 2\.21 s to 2\.79 s after the first byte, \+579 ms \(\+26%\)$/m)
		expect(md).toContain('<details open>')
		expect(md).toContain('| LCP | 2.41 s | 2.99 s | **+579 ms (+26%)** | 2.41 s |')
		expect(md).not.toContain('slip through')
	})

	it('groups a mixed run, regressions first, and lists failed loads', () => {
		const md = render(SCENARIOS.mixed)
		expect(md).toContain('### Lab web vitals: 2 regressions, 2 improvements vs main, 1 page not compared\n')
		expect(md.indexOf('**Regressed**')).toBeLessThan(md.indexOf('**Improved**'))
		expect(md).toContain('- `/checkout` was not compared: this PR failed 6 of 6 loads (HTTP 500).')
		expect(md).toContain('- `/checkout`: prod failed 6 of 6 loads (HTTP 404).')
		expect(md).toContain('- `/`: prod failed 4 of 6 loads (HTTP 503).')
		expect(md.indexOf('**`/`**')).toBeLessThan(md.indexOf('**`/docs`**'))
	})

	it('shows prod as a plain reference value, never as praise or blame', () => {
		const md = render(SCENARIOS.clean)
		expect(md).toContain('| TBT | 281 ms | 284 ms | +3 ms (+1%) | 744 ms |')
		expect(md).not.toMatch(/faster|slower/)
		expect(md).toContain('prod is for reference and never affects the result')
	})

	it('drops the prod column without a prod URL and shows an absolute change from a zero base', () => {
		const md = render(SCENARIOS['missing-prod'])
		expect(md).not.toMatch(/\bprod\b/)
		expect(md).toContain('- **TBT** on `/docs`: 0 ms to 81 ms, +81 ms\n')
	})

	it('says when a metric was dropped instead of hiding it', () => {
		const md = render(SCENARIOS['dropped-metric'])
		expect(md).toContain('- LCP on `/` was left out: only 2 of 8 loads on this PR reported it, 3 needed.')
		expect(md).not.toContain('| LCP | 2.40 s |')
	})

	it('says plainly when nothing could be compared', () => {
		const md = render(SCENARIOS['not-compared'])
		expect(md).toContain('### Lab web vitals: could not compare with main\n')
		expect(commentTitle(SCENARIOS['not-compared'])).toBe('Lab web vitals: could not compare with main')
		expect(md).not.toContain('<details')
		expect(md).not.toContain('slip through')
	})

	it('links leboost PR checks only when the upload returned a URL', () => {
		expect(render(SCENARIOS.clean)).toContain(`[Full run and trend in leboost PR checks](${LEBOOST_URL})`)
		expect(render(SCENARIOS['one-regression'])).not.toContain('leboost')
	})

	it('adds one quiet history line only when asked, and says so when the job fails on regressions', () => {
		const hint = render(SCENARIOS['one-regression'], { historyHint: true })
		expect(hint).toContain('To keep a history of these runs, add a [leboost key](https://github.com/WillSmithTE/leboost-pr-checks#keep-a-history-in-leboost).</sub>')
		expect(hint.match(/leboost/g)).toHaveLength(3)
		const failing = render(SCENARIOS['one-regression'], { failOnRegression: true })
		expect(failing).toContain('<sub>Fails the job on a regression.')
		expect(failing).not.toContain('never fails the build')
	})

	it('counts prod loads on their own in the footer and in failures', () => {
		const result = scenario({})
		result.pages[0].failures.prod = ['HTTP 503']
		const md = render(result)
		expect(md).toContain('Medians of 8 cold mobile loads per side (3 on prod), interleaved,')
		expect(md).toContain('- `/`: prod failed 1 of 3 loads (HTTP 503).')
		expect(render(SCENARIOS['missing-prod'])).toContain('Medians of 8 cold mobile loads per side, interleaved,')
	})

	it('judges LCP and FCP from the first byte, so a slow preview server neither hides nor fakes a change', () => {
		const load = (ttfb: number, paint: number): Metrics => ({ TTFB: ttfb, FCP: ttfb + paint, LCP: ttfb + paint, CLS: 0, TBT: 0 })
		const jitter = [0, 12, -9, 5, -14, 8, -3, 10]
		const side = (ttfb: number, paint: number): Metrics[] => jitter.map((j, i) => load(ttfb + j * 3, paint + j + (i % 2)))
		const page = (base: Metrics[], head: Metrics[]) =>
			build({ prodUrl: null, pages: [{ path: '/', loads: { base, head }, failures: {} }] }).pages[0]

		// Main's server answers 1.3 s slower; the paint after it is the same.
		const slowMain = page(side(1500, 3900), side(150, 3900))
		// TTFB is context only: significant here, yet never a verdict, in the comment or in the upload.
		expect(slowMain.metrics.TTFB?.summary).toMatchObject({ verdict: 'no-change', baseMedian: 1507.5, headMedian: 157.5 })
		expect(slowMain.metrics.TTFB?.summary.pValue).toBeLessThan(0.001)
		// Medians include the jitter: raw 5400 + 10.5 and 4050 + 10.5, after the first byte 3900 + 3 on both sides.
		expect(slowMain.metrics.LCP?.summary).toMatchObject({ verdict: 'no-change', baseMedian: 5410.5, headMedian: 4060.5 })
		expect(slowMain.metrics.LCP?.summary.fromFirstByte).toMatchObject({ baseMedian: 3903, headMedian: 3903 })

		// Paint is 300 ms slower behind a faster first byte: raw LCP drops, the regression is still caught.
		const md = render(build({ prodUrl: null, pages: [{ path: '/', loads: { base: side(1500, 3900), head: side(150, 4200) }, failures: {} }] }))
		expect(md).toMatch(/^- \*\*LCP\*\* on `\/`: 3\.90 s to 4\.20 s after the first byte, \+300 ms \(\+8%\)$/m)
		// Raw LCP fell 1.05 s: the cell splits that into the paint change and the server time.
		expect(md).toContain('| LCP | 5.41 s | 4.36 s | **+300 ms (+8%)**<br><sub>minus 1.35 s server time</sub> |')
		expect(md).toContain("This PR's preview server responded 1.35 s faster than main's on `/`.")
		expect(md).toContain('For LCP and FCP, Change is the time after the first byte')
		// LCP and FCP regressed; the 1.35 s faster first byte is not counted as an improvement.
		expect(md).toContain('### Lab web vitals: 2 regressions vs main\n')
		// Not bold: context only.
		expect(md).toMatch(/^\| TTFB \| 1\.51 s \| 158 ms \| −1\.35 s \(−90%\) \|$/m)
		expect(md).toContain('TTFB is for reference and never affects the result.')
	})

	it('splits a raw paint change into paint and server time when the preview servers differ', () => {
		const md = render(SCENARIOS['slow-preview-server'])
		expect(md).toContain('### Lab web vitals: no significant change vs main\n')
		const server = "This PR's preview server responded 314 ms slower than main's on `/`. That is usually not the code"
		expect(md.indexOf(server)).toBeGreaterThan(-1)
		expect(md.indexOf(server)).toBeLessThan(md.indexOf('moved past run-to-run noise'))
		expect(md).toContain('| LCP | 5.14 s | 5.46 s | +10 ms (0%)<br><sub>plus 314 ms server time</sub> | 4.05 s |')
		expect(md).toContain('| FCP | 3.40 s | 3.72 s | +10 ms (0%)<br><sub>plus 314 ms server time</sub> | 2.26 s |')
		expect(md).toContain('| TTFB | 1.19 s | 1.50 s | +314 ms (+26%) | 210 ms |')
		// `/docs` servers matched, so its rows stay plain.
		expect(md).toContain('| LCP | 2.77 s | 2.78 s | +5 ms (0%) | 2.69 s |')
	})

	it('leaves the server note out while the TTFB gap is under the LCP floor, and names each page past it', () => {
		const load = (ttfb: number, i: number): Metrics => ({ TTFB: ttfb + i, LCP: ttfb + 4000 + i, FCP: ttfb + 2000 + i, CLS: 0, TBT: 0 })
		const side = (ttfb: number): Metrics[] => [0, 4, 1, 3, 2].map(i => load(ttfb, i))
		const page = (path: string, base: number, head: number): PageInput => ({ path, loads: { base: side(base), head: side(head) }, failures: {} })
		// LCP floor is 5% of 4 s after the first byte, 200 ms: a 190 ms gap stays quiet, 210 ms does not.
		const quietRun = render(build({ prodUrl: null, pages: [page('/', 1000, 1190)] }))
		expect(quietRun).not.toMatch(/server time|server responded/)
		const md = render(build({ prodUrl: null, pages: [page('/', 1000, 1210), page('/docs', 1500, 300)] }))
		expect(md).toContain("This PR's preview server responded 210 ms slower than main's on `/` and 1.20 s faster on `/docs`.")
		expect(md).toContain('<sub>plus 210 ms server time</sub>')
		expect(md).toContain('<sub>minus 1.20 s server time</sub>')
	})

	it('uploads TTFB with its samples and test but a no-change verdict, for prod too', () => {
		const load = (ttfb: number): Metrics => ({ TTFB: ttfb, LCP: 4000, FCP: 4000 })
		const pages: PageInput[] = [
			{
				path: '/',
				loads: { base: [1500, 1600, 1550].map(load), head: [100, 120, 110].map(load), prod: [90, 95, 100].map(load) },
				failures: {},
			},
		]
		const ttfb = toUploadPayload(build({ pages })).pages[0].metrics.TTFB
		expect(ttfb?.head).toEqual([100, 120, 110])
		expect(ttfb?.summary).toMatchObject({ verdict: 'no-change', baseMedian: 1550, headMedian: 110 })
		expect(ttfb?.summary.pValue).toBeCloseTo(0.05, 6)
		expect(ttfb?.summary.vsProd?.verdict).toBe('no-change')
	})

	it('skips the prod comparison instead of throwing when prod loads lack the TTFB to time paint from', () => {
		const load = (lcp: number, ttfb?: number): Metrics => ({ LCP: lcp, TTFB: ttfb })
		const side = [load(4000, 150), load(4010, 160), load(3990, 140)]
		const prod = [load(3900), load(3910), load(3920, 100)]
		const lcp = summarisePage('/', { base: side, head: side, prod }, 0.05).metrics.LCP
		expect(lcp?.prod).toEqual([3900, 3910, 3920])
		expect(lcp?.summary.vsProd).toBeNull()
	})

	it('pairs failed loads as null without counting them', () => {
		const load = (lcp: number): Metrics => ({ FCP: lcp, LCP: lcp, CLS: 0, TTFB: 100, TBT: 0 })
		const pages: PageInput[] = [
			{
				path: '/',
				loads: { base: [load(1000), null, load(1010), load(990)], head: [load(1000), load(1005), null, load(995)] },
				failures: { base: ['HTTP 500'], head: ['HTTP 500'] },
			},
		]
		const lcp = build({ prodUrl: null, pages }).pages[0].metrics.LCP
		expect(lcp?.base).toEqual([1000, 1010, 990])
		expect(lcp?.head).toEqual([1000, 1005, 995])
	})

	it('shows a change that rounds to zero without a sign', () => {
		const load = (cls: number): Metrics => ({ FCP: 1000, LCP: 1000, CLS: cls, TTFB: 100, TBT: 0 })
		const pages: PageInput[] = [
			{
				path: '/',
				loads: { base: [0.0004, 0.0004, 0.0004].map(load), head: [0.0001, 0.0001, 0.0001].map(load) },
				failures: { base: [], head: [] },
			},
		]
		const md = render(build({ prodUrl: null, pages }))
		expect(md).toContain('| CLS | 0.000 | 0.000 | 0.000 |')
		expect(md).not.toContain('−0.000')
	})
})

describe('formatValue', () => {
	it('formats values', () => {
		// Non-breaking space, so a narrow table cell never splits the number from its unit.
		expect(formatValue('LCP', 2345)).toBe('2.35 s')
		expect(formatValue('TBT', 87.4)).toBe('87 ms')
		expect(formatValue('CLS', 0.0812)).toBe('0.081')
		expect(formatValue('LCP', null)).toBe('n/a')
	})
})
