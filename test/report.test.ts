import { describe, expect, it } from 'vitest'
import {
	type BuildInput,
	buildResult,
	commentTitle,
	countVerdicts,
	fcpRepeatsLcp,
	formatValue,
	type PageInput,
	renderComment,
	type RunResult,
	summarisePage,
	verdictKey,
} from '../src/report'
import type { History } from '../src/chart'
import { notMeasuredComment } from '../src/main'
import type { Load, Metrics } from '../src/run'
import type { ServerLoad, ServerSamples } from '../src/server'
import fixture from './fixtures/run.json'
import staticHome from './fixtures/static-home.json'

const META: Omit<BuildInput, 'pages'> = { ...fixture.meta, config: { ...fixture.meta.config, device: 'mobile', serverRequests: 0 } }
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

	it('counts verdicts for the outputs, once for an FCP that repeats LCP', () => {
		// /docs: FCP and LCP both 2.01 s to 1.71 s and both faster, so one improvement.
		expect(fcpRepeatsLcp(docs)).toBe(true)
		expect(fcpRepeatsLcp(home)).toBe(false)
		expect(countVerdicts(result)).toEqual({ regressions: 2, improvements: 1 })
	})

	it('keys the verdict on the set of regressions, so only a new verdict posts a new comment', () => {
		expect(verdictKey(result)).toBe('regressed CLS:%2F LCP:%2F')
		expect(verdictKey(null)).toBe('not-measured')
		expect(verdictKey(build({ pages: [FIXTURE_PAGES[2]] }))).toBe('not-compared')
		expect(verdictKey(build({ pages: [] }))).toBe('not-compared')
	})

	it('keeps the test settings and run timing in meta', () => {
		expect(result.meta).toEqual({ alpha: 0.05, prodLoads: null, durationMs: 1000, generatedAt: '2026-10-09T00:00:00Z' })
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

// 30 server time requests per side around a centre, up to 15 ms apart. Server-Timing total is the first byte minus
// 20 ms of network; db and queries only when the centre has them. A cold request is 1.5 s slower.
interface ServerTimeCentre {
	ms: number
	total?: boolean
	db?: number
	queries?: number
	cold?: number[]
	// Server-Timing isolate marker on every request; the cold ones say cold.
	marker?: boolean
	// The 13 requests before the measured ones (10 new connections, 3 warm-up): those that were cold, and how much slower.
	firstCold?: number[]
	coldMs?: number
	// Server-Timing db;desc on every request.
	dbLocation?: string
}
const SERVER_REQUESTS = 30
const FIRST_REQUESTS = 13
function serverTimeSide(side: 'base' | 'head', c: ServerTimeCentre, count = SERVER_REQUESTS, coldAt = c.cold ?? []): ServerLoad[] {
	const { ms, total = false, db, queries, marker = false, coldMs = 1500 } = c
	return Array.from({ length: count }, (_, i) => {
		const cold = coldAt.includes(i)
		const ttfb = ms + (side === 'base' ? ((i * 7) % 11) - 5 : ((i * 5 + 3) % 11) - 5) * 3 + (cold ? coldMs : 0)
		const isolate = marker ? (cold ? 'cold' : 'warm') : null
		return { ttfb, total: total ? ttfb - 20 : null, db: db ?? null, queries: queries ?? null, dbLocation: c.dbLocation ?? null, isolate }
	})
}
const serverSamples = (base: ServerTimeCentre, head: ServerTimeCentre = base): ServerSamples => ({
	base: serverTimeSide('base', base),
	head: serverTimeSide('head', head),
	failures: { base: [], head: [] },
	first: {
		base: serverTimeSide('base', base, FIRST_REQUESTS, base.firstCold ?? []),
		head: serverTimeSide('head', head, FIRST_REQUESTS, head.firstCold ?? []),
	},
})
// `/` reports database time and queries in Server-Timing, `/docs` only the isolate marker, so both are server rendered.
const DOCS_SSR: ServerTimeCentre = { ms: 60, marker: true }
const SERVER: Record<string, ServerSamples> = {
	'/': serverSamples({ ms: 120, db: 12, queries: 3 }),
	'/docs': serverSamples(DOCS_SSR),
}

interface ScenarioOptions {
	home?: Centre
	docs?: Centre
	prod?: boolean
	// Pages that load prod, as prod-paths sets; every page when left out.
	prodPaths?: string[]
	missing?: Record<string, Partial<Record<keyof Centre, number[]>>>
	// Every PR load failed, as when the preview 500s.
	headDown?: boolean
	server?: Record<string, ServerSamples>
	bundle?: BuildInput['bundle']
}

function scenario({ home = HOME, docs = DOCS, prod = true, prodPaths, missing = {}, headDown = false, server = SERVER, bundle = null }: ScenarioOptions): RunResult {
	const headFailures = headDown ? Array<string>(8).fill('HTTP 500') : []
	const page = (path: string, base: Centre, head: Centre, prodCentre: Centre): PageInput => {
		const headLoads: Load[] = headDown ? Array<Load>(8).fill(null) : loads(head, missing[path], HEAD_JITTER)
		const serverRun = headDown ? { ...server[path], head: Array<ServerLoad>(SERVER_REQUESTS).fill(null), failures: { base: [], head: Array<string>(SERVER_REQUESTS).fill('HTTP 500') } } : server[path]
		if (!prod || !(prodPaths?.includes(path) ?? true)) return { path, loads: { base: loads(base), head: headLoads }, failures: { base: [], head: headFailures }, server: serverRun }
		return {
			path,
			loads: { base: loads(base), head: headLoads, prod: loads(prodCentre, {}, PROD_JITTER) },
			failures: { base: [], head: headFailures, prod: [] },
			server: serverRun,
		}
	}
	return build({
		prodUrl: prod ? 'https://shop.example.com' : null,
		prodLoads: prod ? 3 : null,
		config: { ...META.config, pairs: 8, serverRequests: SERVER_REQUESTS },
		pages: [page('/', HOME, home, PROD_HOME), page('/docs', DOCS, docs, PROD_DOCS)],
		bundle,
	})
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
	// Warm requests found both servers equally fast: the cold page loads' first byte gap is not server time.
	const page = (path: string, sides: Record<Side3, ServerCentre>): PageInput => ({
		path,
		loads: { base: serverSide('base', sides.base), head: serverSide('head', sides.head), prod: serverSide('prod', sides.prod) },
		failures: { base: [], head: [], prod: [] },
		server: serverSamples({ ms: 150 }),
	})
	return build({
		prodUrl: 'https://shop.example.com',
		prodLoads: 3,
		config: { ...META.config, pairs: 8, serverRequests: SERVER_REQUESTS },
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

// main's last 20 runs for every compared page and metric: a gentle wobble around today's main median, one run missing.
const WOBBLE = [0.03, 0.01, 0.04, -0.01, 0.02, 0, null, 0.025, -0.015, 0.01, 0.035, 0.005, -0.02, 0.015, 0, 0.02, -0.01, 0.01, 0.005, 0]
function historyFor(result: RunResult): History {
	return Object.fromEntries(
		result.pages.map(page => [
			page.path,
			Object.fromEntries(
				Object.entries(page.metrics).map(([metric, m]) => [metric, WOBBLE.map(w => (w === null ? null : m.summary.baseMedian * (1 + w)))]),
			),
		]),
	)
}

// A real run (fixtures/static-home.json): `/` became a static file on the PR, `/docs` stayed server rendered.
interface JsonServerLoad {
	ttfb: number
	edge: string | null
	total: number | null
	db: number | null
	queries: number | null
	dbLocation: string | null
	isolate: string | null
}
const serverLoad = (s: JsonServerLoad): ServerLoad => ({ ...s, isolate: s.isolate === 'cold' || s.isolate === 'warm' ? s.isolate : null })
const STATIC_HOME: PageInput[] = staticHome.pages.map(p => ({
	path: p.path,
	loads: p.loads,
	failures: p.failures,
	server: {
		base: p.server.base.map(serverLoad),
		head: p.server.head.map(serverLoad),
		first: { base: p.server.first.base.map(serverLoad), head: p.server.first.head.map(serverLoad) },
		failures: p.server.failures,
	},
}))
// The same run with the sides swapped: a page that stopped being static.
const swapSides = (p: PageInput): PageInput => ({
	...p,
	loads: { base: p.loads.head, head: p.loads.base },
	server: p.server && {
		...p.server,
		base: p.server.head,
		head: p.server.base,
		first: p.server.first && { base: p.server.first.head, head: p.server.first.base },
	},
})
const realRun = (pages: PageInput[]): RunResult =>
	build({ prodUrl: null, config: { ...META.config, pairs: 8, serverRequests: SERVER_REQUESTS }, pages })

const SCENARIOS: Record<string, RunResult> = {
	clean: scenario({}),
	'slow-preview-server': slowPreviewServer(),
	'one-regression': scenario({ home: { ...HOME, LCP: 2950 } }),
	// The server marks cold requests: three on main at about 1 s, two on the PR at about 1.5 s. Warm time is unchanged.
	'cold-starts': scenario({
		server: {
			'/': serverSamples(
				{ ms: 120, marker: true, firstCold: [0, 1, 5], coldMs: 900, cold: [12] },
				{ ms: 120, marker: true, firstCold: [0, 2], coldMs: 1400 },
			),
			'/docs': serverSamples(DOCS_SSR),
		},
		bundle: { base: 33_810_000, head: 35_110_000 },
	}),
	// A slower query: 300 ms more server time on `/`, all of it database, with two cold requests on main.
	'server-regression': scenario({
		server: {
			'/': serverSamples({ ms: 120, total: true, db: 12, queries: 3, cold: [4, 17] }, { ms: 420, total: true, db: 312, queries: 4 }),
			'/docs': serverSamples(DOCS_SSR),
		},
	}),
	// The same 5 queries, but the PR's database runs in another data centre: 300 ms slower, shown and not judged.
	'database-apart': scenario({
		server: {
			'/': serverSamples(
				{ ms: 220, db: 55, queries: 5, marker: true, dbLocation: 'DFW' },
				{ ms: 520, db: 326, queries: 5, marker: true, dbLocation: 'SJC' },
			),
			'/docs': serverSamples(DOCS_SSR),
		},
	}),
	// main moved on after the PR's base, and its preview already runs a faster home page.
	'main-ahead': {
		...scenario({ home: { ...HOME, LCP: 2950 } }),
		baseAhead: { ref: 'main', commits: 6, titles: ['Hero image as AVIF', 'Blog index from the loader', 'Docs: QA shots'] },
	},
	// `/docs` is a prerendered file on both sides (no Server-Timing at all): no Server or cold start rows for it.
	'static-both': scenario({ server: { '/': SERVER['/'], '/docs': serverSamples({ ms: 25 }) } }),
	// `/docs` was server rendered on main (Server-Timing total) and is a static file on the PR: an improvement.
	'became-static': scenario({ server: { '/': SERVER['/'], '/docs': serverSamples({ ms: 140, total: true, marker: true }, { ms: 25 }) } }),
	// The reverse: shown with both values and no verdict, never a regression.
	'stopped-static': scenario({ server: { '/': SERVER['/'], '/docs': serverSamples({ ms: 25 }, { ms: 140, total: true, marker: true }) } }),
	mixed: build(),
	'missing-prod': scenario({ prod: false, docs: { ...DOCS, TBT: 80 } }),
	'dropped-metric': scenario({ missing: { '/': { LCP: [0, 2, 3, 4, 5, 7] } } }),
	'not-compared': scenario({ prod: false, headDown: true }),
	'static-home': realRun(STATIC_HOME),
	'static-home-reversed': realRun(STATIC_HOME.map(swapSides)),
}

// Copy outside the table rules: no em dashes, double dashes or empty intensifiers.
const prose = (md: string): string =>
	md
		.split('\n')
		.filter(line => !line.startsWith('|---'))
		.join('\n')

// Plain spaces for readable assertions; the snapshots keep the real non-breaking ones.
const render = (result: RunResult, options = {}): string => renderComment(result, options).replaceAll(' ', ' ')

const CHARTED = ['clean', 'one-regression', 'mixed', 'server-regression'] as const

// Every comment the action can post, by fixture name: each scenario bare, and with charts where history exists.
const ALL_COMMENTS: Record<string, string> = {
	...Object.fromEntries(Object.entries(SCENARIOS).map(([name, result]) => [name, renderComment(result)])),
	...Object.fromEntries(CHARTED.map(name => [`${name}-chart`, renderComment(SCENARIOS[name], { history: historyFor(SCENARIOS[name]) })])),
	'not-measured': notMeasuredComment('Chrome exited before the first load.', { ciRunUrl: META.ciRunUrl }),
}

describe('renderComment', () => {
	for (const [name, md] of Object.entries(ALL_COMMENTS)) {
		it(`matches the ${name} fixture`, async () => {
			await expect(md).toMatchFileSnapshot(`./fixtures/comments/${name}.md`)
		})
	}

	it('has no emoji in any comment', () => {
		// Pictographs, emoji presentation, the emoji variation selector and keycap combiner.
		const emoji = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{FE0F}\u{20E3}]/u
		for (const [name, md] of Object.entries(ALL_COMMENTS)) {
			expect(emoji.test(md), `${name} contains an emoji`).toBe(false)
		}
		expect(emoji.test('Slower 🐢')).toBe(true)
		expect(emoji.test('✅ done')).toBe(true)
	})

	it('opens the fold on a chart for each changed page, and draws none for a quiet run', () => {
		const regression = ALL_COMMENTS['one-regression-chart']
		expect(regression).toMatch(/<\/summary>\n\n<img src="https:\/\/usero\.io\/pr-checks\/chart\.png\?v=1&amp;m=LCP&amp;p=%2F&amp;s=[0-9._]+&amp;c=299" width="520" alt="LCP on \/, main's last 20 runs ranged [^"]+\. This PR: 2\.99 s\.">\n/)
		expect(ALL_COMMENTS['clean-chart']).toBe(ALL_COMMENTS.clean)
		// One chart per page with a change, of its first flagged metric.
		const mixed = ALL_COMMENTS['mixed-chart']
		expect(mixed.match(/<img /g)).toHaveLength(2)
		expect(mixed).toContain('m=LCP&amp;p=%2F&amp;')
		expect(mixed).toContain('m=LCP&amp;p=%2Fdocs&amp;')
	})

	it('leaves the chart out without history, or with too few runs', () => {
		expect(ALL_COMMENTS['one-regression']).not.toContain('<img')
		const short = renderComment(SCENARIOS['one-regression'], { history: { '/': { LCP: [2400, null, 2410] } } })
		expect(short).not.toContain('<img')
	})

	it('leads with the title, ends on one short footer line and keeps to the copy rules', () => {
		for (const md of Object.values(SCENARIOS).map(r => render(r))) {
			expect(md.startsWith('### Lab web vitals: ')).toBe(true)
			expect(md).toMatch(/\n<sub>Report only\. \[How this is measured\]\(https:\/\/github\.com\/usero-feedback\/pr-checks#method\)\. \[CI run\]\([^)]+\) for `9f8e7d6`\.<\/sub>\n$/)
			expect(prose(md)).not.toMatch(/—|--|genuinely|truly|simply|really/)
			expect(md).not.toMatch(/\p{Extended_Pictographic}/u)
			// No explanatory paragraphs: every line is a heading, a table, a list item, a tag or the diff.
			const loose = md.split('\n').filter(l => l !== '' && !/^(###|\||- |\+ |```|<|\*\*)/.test(l) && !l.startsWith('Server bundle'))
			expect(loose).toEqual([])
		}
	})

	it('answers a clean run in the title alone and folds the table away', () => {
		const md = render(SCENARIOS.clean)
		expect(md).toMatch(/^### Lab web vitals: no significant change vs main\n\n<details>\n<summary>All metrics, 8 mobile loads per side<\/summary>\n/)
		// Quiet runs stay short: no summary block, no direction words, no chart.
		expect(md).not.toContain('```diff')
		expect(md).not.toMatch(/Slower|Faster|Worse|Better|<img/)
	})

	it('names each regression in a diff block with page, metric, size and word, and opens the table', () => {
		const md = render(SCENARIOS['one-regression'])
		expect(md).toContain('### Lab web vitals: 1 regression vs main\n\n```diff\n- LCP  /  579 ms slower (26%)\n```\n\n<details open>\n')
		expect(md).toContain('| LCP | 2.41 s | 2.99 s | **Slower** +579 ms (+26%) |')
		// Unchanged rows carry no word and no percent.
		expect(md).toContain('| FCP | 1.80 s | 1.82 s | +16 ms |')
	})

	it('leaves out rows that say nothing: zero on both sides, or an FCP that repeats LCP', () => {
		const md = render(SCENARIOS.clean)
		const docs = md.slice(md.indexOf('**`/docs`**'))
		// /docs has CLS 0.000 and TBT 0 ms on both sides.
		expect(docs).not.toMatch(/\| (CLS|TBT) \|/)
		expect(md).toContain('| CLS | 0.002 | 0.002 | 0.000 |')
		const mixed = render(SCENARIOS.mixed)
		const mixedDocs = mixed.slice(mixed.indexOf('**`/docs`**'))
		expect(mixedDocs).toContain('| LCP | 2.01 s | 1.71 s | **Faster** −302 ms (−16%) |')
		expect(mixedDocs).not.toContain('| FCP |')
		expect(mixed).not.toContain('+ FCP')
	})

	it('puts regressions on - lines before improvements on + lines, aligned, and lists failed loads', () => {
		const md = render(SCENARIOS.mixed)
		expect(md).toContain('### Lab web vitals: 2 regressions, 1 improvement vs main, 1 page not compared\n')
		expect(md).toContain(
			['```diff', '- LCP  /      500 ms slower (23%)', '- CLS  /       0.079 worse', '+ LCP  /docs  302 ms faster (16%)', '```'].join('\n'),
		)
		expect(md).toContain('| CLS | 0.002 | 0.081 | **Worse** +0.079 |')
		// A page this PR broke stays in view under the diff; prod failures fold away, they never touch the verdict.
		expect(md).toContain('```\n\n**Incomplete data**\n\n- `/checkout` was not compared: this PR failed 6 of 6 loads (HTTP 500).\n\n<details open>')
		expect(md.match(/\*\*Incomplete data\*\*/g)).toHaveLength(1)
		expect(md.indexOf('- `/`: prod failed 4 of 6 loads (HTTP 503).')).toBeGreaterThan(md.indexOf('<details open>'))
		expect(md).toContain('- `/checkout`: prod failed 6 of 6 loads (HTTP 404).')
		expect(md).toContain('- `/`: prod failed 4 of 6 loads (HTTP 503).')
		expect(md.indexOf('**`/`**')).toBeLessThan(md.indexOf('**`/docs`**'))
	})

	it('shows prod as one plain reference line per page, never as praise or blame', () => {
		const md = render(SCENARIOS.clean)
		expect(md).toContain('| TBT | 281 ms | 284 ms | +3 ms |\n| Server | 120 ms | 120 ms | 0 ms |\n\n<sub>prod for reference: LCP 2.41 s, FCP 1.81 s, CLS 0.002, TBT 744 ms</sub>\n')
		// Only the metrics the table shows.
		expect(md).toContain('<sub>prod for reference: LCP 2.02 s, FCP 1.71 s</sub>')
		expect(md).not.toMatch(/faster|slower/)
		expect(md.match(/\| Metric \| main \| this PR \| Change \|\n/g)).toHaveLength(2)
	})

	it('has no prod line without a prod URL and shows an absolute change from a zero base', () => {
		const md = render(SCENARIOS['missing-prod'])
		expect(md).not.toMatch(/\bprod\b/)
		// No percent of a zero base.
		expect(md).toContain('```diff\n- TBT  /docs  81 ms slower\n```')
		expect(md).toContain('| TBT | 0 ms | 81 ms | **Slower** +81 ms |')
	})

	it('has no prod line and no prod failure for a page outside prod-paths', () => {
		const result = scenario({ prodPaths: ['/'] })
		const md = render(result)
		expect(md).toContain('<sub>prod for reference: LCP 2.41 s, FCP 1.81 s, CLS 0.002, TBT 744 ms</sub>')
		expect(md.match(/prod for reference/g)).toHaveLength(1)
		expect(md.slice(md.indexOf('**`/docs`**'))).not.toMatch(/\bprod\b/)
		expect(md).not.toContain('prod failed')
		expect(result.pages[1].metrics.LCP?.summary.vsProd).toBeUndefined()
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

	it('says in the footer when the job fails on regressions', () => {
		const failing = render(SCENARIOS['one-regression'], { failOnRegression: true })
		expect(failing).toContain('<sub>Fails the job on a regression. [How this is measured]')
		expect(failing).not.toContain('Report only')
	})

	it('counts prod loads on their own in failures', () => {
		const result = scenario({})
		result.pages[0].failures.prod = ['HTTP 503']
		expect(render(result)).toContain('- `/`: prod failed 1 of 3 loads (HTTP 503).')
	})

	it('judges LCP and FCP from the first byte, so a slow preview server neither hides nor fakes a change', () => {
		const load = (ttfb: number, paint: number): Metrics => ({ TTFB: ttfb, FCP: ttfb + paint, LCP: ttfb + paint, CLS: 0, TBT: 0 })
		const jitter = [0, 12, -9, 5, -14, 8, -3, 10]
		const side = (ttfb: number, paint: number): Metrics[] => jitter.map((j, i) => load(ttfb + j * 3, paint + j + (i % 2)))
		const page = (base: Metrics[], head: Metrics[]) =>
			build({ prodUrl: null, pages: [{ path: '/', loads: { base, head }, failures: {} }] }).pages[0]

		// Main's server answers 1.3 s slower; the paint after it is the same.
		const slowMain = page(side(1500, 3900), side(150, 3900))
		// TTFB is context only: significant here, yet never a verdict, in the comment or in vitals.json.
		expect(slowMain.metrics.TTFB?.summary).toMatchObject({ verdict: 'no-change', baseMedian: 1507.5, headMedian: 157.5 })
		expect(slowMain.metrics.TTFB?.summary.pValue).toBeLessThan(0.001)
		// Medians include the jitter: raw 5400 + 10.5 and 4050 + 10.5, after the first byte 3900 + 3 on both sides.
		expect(slowMain.metrics.LCP?.summary).toMatchObject({ verdict: 'no-change', baseMedian: 5410.5, headMedian: 4060.5 })
		expect(slowMain.metrics.LCP?.summary.fromFirstByte).toMatchObject({ baseMedian: 3903, headMedian: 3903 })

		// Paint is 300 ms slower behind a faster first byte: raw LCP drops, the regression is still caught.
		const md = render(build({ prodUrl: null, pages: [{ path: '/', loads: { base: side(1500, 3900), head: side(150, 4200) }, failures: {} }] }))
		// Raw LCP fell 1.05 s, yet the line says slower: it reports the time after the first byte.
		expect(md).toMatch(/^- LCP {2}\/ {2}300 ms slower \(8%\)$/m)
		// The full change (−1.05 s) runs against the verdict, so Change shows what was judged and the note says what was left out.
		expect(md).toContain('| LCP | 5.41 s | 4.36 s | **Slower** +300 ms (+8%) |\n\n<sub>Judged after the first byte: LCP +300 ms. First byte −1.35 s left out</sub>')
		// FCP here is LCP, so one regression; the 1.35 s faster first byte of the page loads counts nowhere.
		expect(md).toContain('### Lab web vitals: 1 regression vs main\n')
		expect(md).not.toContain('| FCP |')
		expect(md).not.toMatch(/\| TTFB \||server responded/)
	})

	it('times paint from documentStart when the browser was still starting up at the first byte', () => {
		// A 1 ms server: the browser is ready at 170 ms. 300 ms slower: ready right after the first byte. Same paint after it.
		const fast = (i: number): Metrics => ({ TTFB: 1, documentStart: 170 + i, FCP: 800 + i, LCP: 800 + i })
		const slow = (i: number): Metrics => ({ TTFB: 301, documentStart: 305 + i, FCP: 935 + i, LCP: 935 + i })
		const rounds = [0, 3, 1, 4, 2, 5, 7, 6]
		const page = build({ prodUrl: null, pages: [{ path: '/', loads: { base: rounds.map(fast), head: rounds.map(slow) }, failures: {} }] }).pages[0]
		expect(page.metrics.LCP?.summary.fromFirstByte).toMatchObject({ baseMedian: 630, headMedian: 630 })
		expect(page.metrics.FCP?.summary.verdict).toBe('no-change')
	})

	it('shows no percent for server time on a base under the floor', () => {
		const result = build({
			prodUrl: null,
			config: { ...META.config, serverRequests: SERVER_REQUESTS },
			pages: [{ path: '/', loads: { base: [], head: [] }, failures: {}, server: serverSamples({ ms: 16 }, { ms: 316 }) }],
		})
		expect(result.pages[0].metrics.Server?.summary.deltaPct).toBeNull()
		expect(render(result)).toContain('- Server  /  300 ms slower\n')
	})

	it('judges server time from warm requests, not from the cold page loads first byte', () => {
		const md = render(SCENARIOS['slow-preview-server'])
		// The page loads saw a 314 ms slower first byte on `/`; warm requests found the servers equal.
		expect(md).toContain('### Lab web vitals: no significant change vs main\n')
		// Change agrees with the medians; one note says only 10 ms of it is judged, and what was left out.
		expect(md).toContain('| LCP | 5.14 s | 5.46 s | +322 ms |')
		expect(md).toContain('| FCP | 3.40 s | 3.72 s | +322 ms |')
		expect(md).toContain(
			'| Server | 150 ms | 150 ms | 0 ms |\n\n<sub>Judged after the first byte: LCP +10 ms, FCP +10 ms. First byte +312 ms left out, server time 0 ms<br>prod for reference:',
		)
		// On /docs the first byte did not move past the floor, so no note.
		expect(md.match(/First byte/g)).toHaveLength(1)
		expect(md).not.toMatch(/\| TTFB \||server responded|usually not the code/)
	})

	it('flags a server regression once, in the Server row, with database time and cold requests', () => {
		const result = SCENARIOS['server-regression']
		const server = result.pages[0].metrics.Server
		expect(server?.summary.verdict).toBe('regressed')
		expect(server?.server).toMatchObject({
			source: 'server-timing',
			db: { baseMedian: 12, headMedian: 312 },
			queries: { baseMedian: 3, headMedian: 4 },
			coldStarts: { source: { base: 'outliers', head: 'outliers' }, base: [1623, 1632], head: [], requests: { base: 43, head: 43 } },
		})
		// The two cold requests are left out of the test and the medians.
		expect(server?.base).toHaveLength(28)
		const md = render(result)
		expect(md).toContain('### Lab web vitals: 1 regression vs main\n\n```diff\n- Server  /  300 ms slower (300%)\n```\n')
		expect(md).toContain(
			'| Server | 100 ms | 400 ms | **Slower** +300 ms (+300%) |',
		)
		expect(md).toContain(
			'<sub>Server db 12 ms to 312 ms, 3 to 4 queries<br>Cold starts 1.63 s to none (2 and 0 of 43), not judged<br>prod for reference:',
		)
		expect(countVerdicts(result)).toEqual({ regressions: 1, improvements: 0 })
	})

	it('shows both server times without a verdict when the databases run in different places, and says why', () => {
		const result = SCENARIOS['database-apart']
		expect(result.pages[0].metrics.Server?.summary.verdict).toBe('no-change')
		const md = render(result)
		expect(md).toContain('### Lab web vitals: no significant change vs main\n')
		expect(md).toContain('| Server | 220 ms | 520 ms | not judged |')
		expect(md).toContain('<sub>Database in DFW on main and SJC on this PR (db 55 ms to 326 ms), so server time is not judged')
		expect(verdictKey(result)).toBe('clean')
	})

	it('says when main is past the PR base, only when something changed, with the newest commits in the fold', () => {
		const md = render(SCENARIOS['main-ahead'])
		expect(md).toContain(
			"```\n\n<sub>main is 6 commits past this PR's base, and its preview may already run them, so a change above can be theirs. Merge main and push to compare like for like.</sub>\n\n<details open>",
		)
		expect(md).toContain('<sub>Newest on main since this PR\'s base: "Hero image as AVIF", "Blog index from the loader", "Docs: QA shots".</sub>')
		const quiet = render({ ...SCENARIOS.clean, baseAhead: { ref: 'main', commits: 6, titles: ['Hero image as AVIF'] } })
		expect(quiet).toBe(render(SCENARIOS.clean))
		const level = render({ ...SCENARIOS['one-regression'], baseAhead: { ref: 'main', commits: 0, titles: [] } })
		expect(level).toBe(render(SCENARIOS['one-regression']))
	})

	it('shows database time only under a judged Server change on a page that queries', () => {
		// The clean run's `/` sends db 12 ms and 3 queries, unchanged.
		expect(render(SCENARIOS.clean)).not.toContain('queries')
		const noQueries = scenario({
			server: { '/': serverSamples({ ms: 120, db: 0, queries: 0 }, { ms: 420, db: 0, queries: 0 }), '/docs': serverSamples(DOCS_SSR) },
		})
		const md = render(noQueries)
		expect(md).toContain('- Server  /  300 ms slower')
		expect(md).not.toContain('queries')
	})

	it('drops the Server and cold start rows for a page that is a static file on both sides', () => {
		const result = SCENARIOS['static-both']
		const [, docs] = result.pages
		expect(docs.serverStatic).toBe(true)
		expect(docs.metrics.Server).toBeUndefined()
		const md = render(result)
		const section = md.slice(md.indexOf('**`/docs`**'))
		expect(section).not.toMatch(/Server|Cold starts|static/)
		// The server rendered page keeps its row, and nothing is reported as incomplete.
		expect(md).toContain('| Server | 120 ms | 120 ms |')
		expect(md).not.toContain('Incomplete data')
		expect(md).toContain('### Lab web vitals: no significant change vs main\n')
	})

	it('treats a page that became static as an improvement, compared by first byte', () => {
		const result = SCENARIOS['became-static']
		const server = result.pages[1].metrics.Server
		expect(server?.server?.static).toEqual({ base: false, head: true })
		expect(server?.server?.source).toBe('ttfb')
		expect(server?.summary.verdict).toBe('improved')
		expect(countVerdicts(result)).toEqual({ regressions: 0, improvements: 1 })
		expect(verdictKey(result)).toBe('clean')
		const md = render(result)
		expect(md).toContain('### Lab web vitals: 1 improvement vs main\n')
		expect(md).toContain('+ Server  /docs  115 ms faster (82%)')
		expect(md).toContain('| Server | 140 ms | 25 ms (static) | **Faster** −115 ms (−82%) |')
		expect(md).toContain('Server now static')
	})

	it('never reads a page that stopped being static as a regression', () => {
		const result = SCENARIOS['stopped-static']
		const server = result.pages[1].metrics.Server
		expect(server?.summary.verdict).toBe('no-change')
		expect(countVerdicts(result)).toEqual({ regressions: 0, improvements: 0 })
		expect(verdictKey(result)).toBe('clean')
		const md = render(result)
		expect(md).toContain('| Server | 25 ms (static) | 140 ms | not judged |')
		expect(md).toContain('Server no longer static')
		expect(md).not.toMatch(/Slower|\+ ?\d+ ms \(\+/)
	})

	it('counts the first byte in LCP when a page became static, so painting 962 ms sooner reads as that, not −54 ms', () => {
		const result = SCENARIOS['static-home']
		const [home, docs] = result.pages
		expect(home.staticSides).toEqual({ base: false, head: true })
		// Main's first byte was cold on 5 of 8 loads (1.12 to 1.54 s); the static file never was.
		expect(home.metrics.LCP?.summary).toMatchObject({ verdict: 'improved', baseMedian: 4012, headMedian: 3050, fromFirstByte: null })
		// Server rendered on both sides: cold first bytes there are the preview's, so /docs is still judged after them.
		expect(docs.staticSides).toEqual({ base: false, head: false })
		expect(docs.metrics.LCP?.summary.verdict).toBe('no-change')
		expect(docs.metrics.LCP?.summary.fromFirstByte).not.toBeNull()
		const md = render(result)
		expect(md).toContain('### Lab web vitals: 2 improvements vs main\n')
		expect(md).toMatch(/^\+ LCP {5}\/ {2}962 ms faster \(24%\)$/m)
		expect(md).toContain('| LCP | 4.01 s | 3.05 s | **Faster** −962 ms (−24%) |')
		expect(md).toContain('<sub>Server now static, so LCP counts the first byte (1.14 s to 104 ms)<br>')
		expect(md).not.toContain('−54 ms')
		// /docs: Change agrees with the medians, and the note says what the verdict left out.
		expect(md).toContain('| LCP | 3.45 s | 3.95 s | +498 ms |')
		// The job log rounds documentStart, so 1 ms off the posted comment's +20 and +478.
		expect(md).toContain('<sub>Judged after the first byte: LCP +19 ms. First byte +479 ms left out, server time +7 ms<br>')
	})

	it('flags LCP when a page stopped being static and paints 962 ms later', () => {
		const result = SCENARIOS['static-home-reversed']
		expect(result.pages[0].metrics.LCP?.summary.verdict).toBe('regressed')
		expect(verdictKey(result)).toBe('regressed LCP:%2F')
		const md = render(result)
		expect(md).toContain('| LCP | 3.05 s | 4.01 s | **Slower** +962 ms (+32%) |')
		expect(md).toContain('| Server | 24 ms (static) | 61 ms | not judged |')
		expect(md).toContain('<sub>Server no longer static, so LCP counts the first byte (104 ms to 1.14 s)<br>')
	})

	it('never shows a Change far below the full change without saying what was left out', () => {
		// mulberry32: the same runs every time, so a failure reproduces.
		let seed = 325
		const rand = (): number => {
			seed = (seed + 0x6d2b79f5) | 0
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296
		}
		// A share of loads with a cold first byte, the browser ready at about 200 ms, then paint after both.
		const side = (cold: number, paint: number): Metrics[] =>
			Array.from({ length: 8 }, () => {
				const TTFB = rand() < cold ? 1000 + rand() * 900 : 50 + rand() * 200
				const documentStart = Math.max(TTFB, 170 + rand() * 80) + rand() * 40
				const p = paint + rand() * 150 - 75
				return { TTFB, documentStart, LCP: documentStart + p, FCP: documentStart + p * 0.7, CLS: 0, TBT: 0 }
			})
		const ms = (cell: string): number => {
			const m = /([+−]?)(\d+(?:\.\d+)?) (ms|s)/.exec(cell)
			if (!m) throw new Error(`no time in ${cell}`)
			return (m[1] === '−' ? -1 : 1) * Number(m[2]) * (m[3] === 's' ? 1000 : 1)
		}
		const shapes: [ServerTimeCentre, ServerTimeCentre][] = [
			[{ ms: 120, marker: true }, { ms: 120, marker: true }],
			[{ ms: 120, marker: true }, { ms: 25 }],
			[{ ms: 25 }, { ms: 120, marker: true }],
			[{ ms: 120, marker: true }, { ms: 420, marker: true }],
		]
		let explained = 0
		for (let run = 0; run < 120; run++) {
			const [base, head] = shapes[run % shapes.length]
			const paint = 2000 + rand() * 1000
			const page: PageInput = {
				path: '/',
				loads: { base: side(rand(), paint), head: side(rand(), paint + (rand() < 0.5 ? 0 : rand() * 1200 - 600)) },
				failures: {},
				server: serverSamples(base, head),
			}
			const result = realRun([page])
			const md = render(result)
			const note = /^<sub>((?!Report only).*)<\/sub>$/m.exec(md)?.[1] ?? ''
			const rendering = result.pages[0].staticSides
			for (const metric of ['LCP', 'FCP'] as const) {
				const row = new RegExp(`^\\| ${metric} \\| ([^|]+) \\| ([^|]+) \\| ([^|]+) \\|$`, 'm').exec(md)
				if (!row) continue
				const full = ms(row[2]) - ms(row[1])
				const change = row[3].trim() === '0 ms' ? 0 : ms(row[3])
				// The verdict word and the number beside it never disagree.
				if (row[3].includes('**Faster**')) expect(change).toBeLessThan(0)
				if (row[3].includes('**Slower**')) expect(change).toBeGreaterThan(0)
				// Within the 100 ms floor (plus 20 ms of rounding on values in seconds) of the full change, or the note says why.
				const far = Math.abs(full) - Math.abs(change) >= 120 || (Math.abs(full) >= 120 && Math.sign(change) !== Math.sign(full))
				if (far) {
					expect(note).toMatch(new RegExp(`Judged after the first byte: [^.]*${metric} `))
					explained++
				}
				// A static file on one side only: the first byte is the PR's, never left out.
				if (rendering && rendering.base !== rendering.head) {
					expect(result.pages[0].metrics[metric]?.summary.fromFirstByte).toBeNull()
					expect(note).not.toContain('left out')
				}
			}
		}
		// The note path was exercised, not just skipped.
		expect(explained).toBeGreaterThan(10)
	}, 30_000)

	it('keeps comparing first bytes when no page in the run ever sends Server-Timing', () => {
		const plain = scenario({ server: { '/': serverSamples({ ms: 120 }), '/docs': serverSamples({ ms: 60 }, { ms: 360 }) } })
		expect(plain.pages.every(p => !p.serverStatic)).toBe(true)
		expect(plain.pages[1].metrics.Server?.summary.verdict).toBe('regressed')
		expect(plain.pages[1].metrics.Server?.server?.static).toEqual({ base: false, head: false })
	})

	it('reports cold starts the server marked, from every phase, without judging them', () => {
		const result = SCENARIOS['cold-starts']
		const server = result.pages[0].metrics.Server
		expect(server?.server?.coldStarts.source).toEqual({ base: 'isolate', head: 'isolate' })
		expect(server?.server?.coldStarts.base).toHaveLength(4)
		expect(server?.server?.coldStarts.head).toHaveLength(2)
		// The marked cold request among the measured ones is left out of the warm test.
		expect(server?.base).toHaveLength(29)
		expect(server?.summary.verdict).toBe('no-change')
		const md = render(result)
		expect(md).toContain('### Lab web vitals: no significant change vs main\n')
		expect(md).toMatch(/^\| Server \| 120 ms \| 120 ms \| 0 ms \|\n\n<sub>Cold starts 1\.0\d s to 1\.5\d s \(4 and 2 of 43\), not judged<br>/m)
		expect(md).toContain('Server bundle 33.8 MB to 35.1 MB (+1.30 MB, +3.8%), not judged.')
	})

	it('says when only one bundle size was given, and leaves the line out without either', () => {
		const one = render(build({ prodUrl: null, bundle: { base: null, head: 912_400 } }))
		expect(one).toContain("Server bundle 912 KB on this PR, main's size not given.")
		expect(render(build({ prodUrl: null, bundle: { base: 912_400, head: 912_400 } }))).toContain('Server bundle 912 KB, no change.')
		expect(render(build({ prodUrl: null, bundle: { base: null, head: null } }))).not.toContain('Server bundle')
	})

	it('keeps TTFB with its samples and test but a no-change verdict, for prod too', () => {
		const load = (ttfb: number): Metrics => ({ TTFB: ttfb, LCP: 4000, FCP: 4000 })
		const pages: PageInput[] = [
			{
				path: '/',
				loads: { base: [1500, 1600, 1550].map(load), head: [100, 120, 110].map(load), prod: [90, 95, 100].map(load) },
				failures: {},
			},
		]
		const ttfb = build({ pages }).pages[0].metrics.TTFB
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

	it('shows a change that rounds to zero without a sign, and leaves out a row that reads zero on both sides', () => {
		const load = (cls: number, i: number): Metrics => ({ FCP: 500, LCP: 1000 + (cls > 0.0002 ? 0.3 : 0) + i, CLS: cls, TTFB: 100, TBT: 0 })
		const pages: PageInput[] = [
			{
				path: '/',
				loads: { base: [0.0004, 0.0004, 0.0004].map(load), head: [0.0001, 0.0001, 0.0001].map(load) },
				failures: { base: [], head: [] },
			},
		]
		const md = render(build({ prodUrl: null, pages }))
		expect(md).toContain('| LCP | 1.00 s | 1.00 s | 0 ms |')
		expect(md).not.toMatch(/\| (CLS|TBT) \||−0/)
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
