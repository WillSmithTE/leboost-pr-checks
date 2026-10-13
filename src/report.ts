// Turns raw samples into the result document and the PR comment.
import {
	COLD,
	CONTEXT_ONLY,
	type DeviceName,
	FLOORS,
	type Floor,
	FROM_FIRST_BYTE,
	LOAD_METRICS,
	METRICS,
	type MetricName,
	SERVER_CONNECTIONS,
} from './config'
import type { Load, PageSamples, SideName } from './run'
import { chartImage, type History } from './chart'
import type { BaseAhead } from './github'
import type { ServerLoad, ServerSample, ServerSamples } from './server'
import { compareSamples, type Comparison, median, type Verdict } from './stats'

const MIN_SAMPLES = 3

export interface FromFirstByte {
	baseMedian: number
	headMedian: number
	deltaPct: number | null
}

export interface VsProd {
	prodMedian: number
	deltaPct: number | null
	pValue: number
	shiftLow: number
	shiftHigh: number
	verdict: Verdict
}

export interface MetricSummary extends Comparison {
	fromFirstByte: FromFirstByte | null
	vsProd?: VsProd | null
}

export interface MedianPair {
	baseMedian: number | null
	headMedian: number | null
}

export interface ServerDetail {
	// What was tested: Server-Timing's total when every good request on both sides carried one, else the first byte.
	source: 'server-timing' | 'ttfb'
	// A side that sends no Server-Timing while the site does elsewhere is a prerendered static file, not server code.
	static: StaticSides
	db: MedianPair | null
	queries: MedianPair | null
	// Where each side's database runs, from Server-Timing db;desc; null when neither side says. Two places: not judged.
	dbLocation: { base: string | null; head: string | null } | null
	// The CDN edge each side mostly reached and the one compared (null when they share none: not judged). Null when the
	// site names no edge.
	edge?: EdgeChoice | null
	// The same test on each kept-alive connection's median; a verdict needs both to agree. Null under 3 connections a side.
	byConnection: { base: number[]; head: number[]; shift: number; pValue: number; verdict: Verdict } | null
	coldStarts: ColdStarts
	requests: { base: ServerLoad[]; head: ServerLoad[]; first: { base: ServerLoad[]; head: ServerLoad[] } }
}

export interface StaticSides {
	base: boolean
	head: boolean
}

// Requests that reached a cold server instance, from every phase, reported but never judged.
export interface ColdStarts {
	// Per side. isolate: the server said so in Server-Timing; outliers: first byte past the cold limit (COLD in config.ts).
	source: { base: 'isolate' | 'outliers'; head: 'isolate' | 'outliers' }
	// First-byte times of the cold requests.
	base: number[]
	head: number[]
	// Good requests per side, every phase.
	requests: { base: number; head: number }
}

export interface MetricResult {
	// For Server, the tested values without cold outliers.
	base: number[]
	head: number[]
	prod?: number[]
	summary: MetricSummary
	server?: ServerDetail
}

export interface Dropped {
	metric: MetricName
	base: number
	head: number
}

export interface PageResult {
	path: string
	metrics: Partial<Record<MetricName, MetricResult>>
	dropped: Dropped[]
	failures: PageSamples['failures']
	// Failed server time requests per side; null when server time was not measured.
	serverFailures: ServerSamples['failures'] | null
	// Both sides are static files: there is no server time to compare, so no Server or cold start rows.
	serverStatic: boolean
}

export interface RunConfig {
	pairs: number
	// Server time requests per side and page, 0 when turned off.
	serverRequests: number
	device: DeviceName
	latencyMs: number
	downloadKbps: number
	uploadKbps: number
	cpuSlowdown: number
}

export interface RunMeta {
	repo: string | null
	prNumber: number | null
	branch: string | null
	headSha: string
	baseSha: string | null
	baseUrl: string
	headUrl: string
	prodUrl: string | null
	ciRunUrl: string | null
	config: RunConfig
}

// Server bundle size in bytes per side, from the base-bundle-bytes and head-bundle-bytes inputs; null when not given.
export interface BundleSizes {
	base: number | null
	head: number | null
}

export interface RunResult extends RunMeta {
	version: 1
	pages: PageResult[]
	bundle: BundleSizes | null
	// Commits main gained after this PR's base, read when the run ends; null when unknown or not a PR.
	baseAhead?: BaseAhead | null
	meta: {
		alpha: number
		prodLoads: number | null
		durationMs: number | null
		generatedAt: string | null
	}
}

export interface PageInput {
	path: string
	loads: PageSamples['samples']
	failures: PageSamples['failures']
	server?: ServerSamples | null
}

type Values = (number | null | undefined)[]
const values = (loads: readonly Load[], metric: MetricName): Values => loads.map(m => m?.[metric])
const column = (loads: readonly Load[], metric: MetricName): number[] =>
	values(loads, metric).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
const finiteCount = (xs: Values): number => xs.filter(v => typeof v === 'number' && Number.isFinite(v)).length
const finiteOrNull = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// Paint time after the first byte, or after documentStart when later: a browser still starting up when a fast server's
// first byte arrives would otherwise make any slower server look like faster paint. Undefined when a value is missing.
const fromFirstByte = (loads: readonly Load[], metric: MetricName): Values =>
	loads.map(m => {
		const paint = finiteOrNull(m?.[metric])
		const ttfb = finiteOrNull(m?.TTFB)
		if (paint === null || ttfb === null) return undefined
		return paint - Math.max(ttfb, finiteOrNull(m?.documentStart) ?? ttfb)
	})
// A percent of a zero base means nothing (common for CLS and TBT).
const changePct = (base: number, head: number): number | null => (base === 0 ? null : ((head - base) / base) * 100)
// Six significant digits keeps float noise (120.55000000000001) out of the JSON and the comment.
const tidy = (v: number): number => Number(v.toPrecision(6))
const tidyPct = (v: number | null): number | null => (v === null ? null : tidy(v))

export interface SummariseOptions {
	floors?: Record<MetricName, Floor>
	firstByte?: readonly MetricName[]
	contextOnly?: readonly MetricName[]
}

// Metrics in firstByte are tested on their time after the first byte (README, Method); the medians and deltaPct
// stay raw, and summary.fromFirstByte holds the tested medians. Metrics in contextOnly keep their p-value and
// shift but their verdict is always no-change.
export function summarisePage(
	path: string,
	samples: PageSamples['samples'],
	alpha: number,
	{ floors = FLOORS, firstByte = FROM_FIRST_BYTE, contextOnly = CONTEXT_ONLY }: SummariseOptions = {},
): Omit<PageResult, 'failures' | 'serverFailures' | 'serverStatic'> {
	const metrics: PageResult['metrics'] = {}
	const dropped: Dropped[] = []
	for (const metric of LOAD_METRICS) {
		const base = column(samples.base, metric)
		const head = column(samples.head, metric)
		if (base.length < MIN_SAMPLES || head.length < MIN_SAMPLES) {
			if (base.length + head.length > 0) dropped.push({ metric, base: base.length, head: head.length })
			continue
		}
		const shifted =
			firstByte.includes(metric) &&
			finiteCount(fromFirstByte(samples.base, metric)) >= MIN_SAMPLES &&
			finiteCount(fromFirstByte(samples.head, metric)) >= MIN_SAMPLES
		const tested = (loads: readonly Load[]): Values => (shifted ? fromFirstByte(loads, metric) : values(loads, metric))
		const y = tested(samples.head)
		const context = contextOnly.includes(metric)
		const floor = floors[metric]
		const entry: MetricResult = {
			base,
			head,
			summary: summarise(compareSamples(tested(samples.base), y, { alpha, ...floor }), base, head, shifted, context),
		}
		if (samples.prod) {
			const prod = column(samples.prod, metric)
			const prodTested = tested(samples.prod)
			entry.prod = prod
			entry.summary.vsProd = null
			if (prod.length >= MIN_SAMPLES && finiteCount(prodTested) >= MIN_SAMPLES) {
				const vs = summarise(compareSamples(prodTested, y, { alpha, ...floor }), prod, head, shifted, context)
				entry.summary.vsProd = {
					prodMedian: vs.baseMedian,
					deltaPct: vs.deltaPct,
					pValue: vs.pValue,
					shiftLow: vs.shiftLow,
					shiftHigh: vs.shiftHigh,
					verdict: vs.verdict,
				}
			}
		}
		metrics[metric] = entry
	}
	return { path, metrics, dropped }
}

// Raw medians and deltaPct for display, the test result from whatever was tested.
function summarise(test: Comparison, base: number[], head: number[], shifted: boolean, context: boolean): MetricSummary {
	const baseMedian = median(base) ?? 0
	const headMedian = median(head) ?? 0
	return {
		baseMedian: tidy(baseMedian),
		headMedian: tidy(headMedian),
		deltaPct: tidyPct(changePct(baseMedian, headMedian)),
		pValue: tidy(test.pValue),
		shiftLow: tidy(test.shiftLow),
		shiftHigh: tidy(test.shiftHigh),
		shift: tidy(test.shift),
		floor: tidy(test.floor),
		verdict: context ? 'no-change' : test.verdict,
		fromFirstByte: shifted
			? { baseMedian: tidy(test.baseMedian), headMedian: tidy(test.headMedian), deltaPct: tidyPct(test.deltaPct) }
			: null,
	}
}

// The cut-off above which a side's server times are cold outliers, or null when none are left out.
export function coldLimit(values: readonly number[], { factor, plusMs, maxShare } = COLD): number | null {
	const m = median(values)
	if (m === null) return null
	const limit = Math.max(factor * m, m + plusMs)
	const over = values.filter(v => v > limit).length
	return over > 0 && over <= Math.floor(maxShare * values.length) ? limit : null
}

function medianPair(base: readonly ServerSample[], head: readonly ServerSample[], key: 'db' | 'queries'): MedianPair | null {
	const pair = { baseMedian: median(base.map(s => s[key])), headMedian: median(head.map(s => s[key])) }
	if (pair.baseMedian === null && pair.headMedian === null) return null
	return { baseMedian: pair.baseMedian === null ? null : tidy(pair.baseMedian), headMedian: pair.headMedian === null ? null : tidy(pair.headMedian) }
}

export interface EdgeChoice {
	base: string | null
	head: string | null
	compared: string | null
}

// The edge both sides reached most often, by the smaller side's count; null when neither side names one.
function edgeFor(base: readonly ServerSample[], head: readonly ServerSample[]): EdgeChoice | null {
	const count = (side: readonly ServerSample[]): Map<string, number> => {
		const m = new Map<string, number>()
		for (const s of side) if (s.edge) m.set(s.edge, (m.get(s.edge) ?? 0) + 1)
		return m
	}
	const [b, h] = [count(base), count(head)]
	if (b.size === 0 || h.size === 0) return null
	const top = (m: Map<string, number>): string | null => [...m].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null
	let compared: string | null = null
	let best = 0
	for (const [edge, n] of b) {
		const both = Math.min(n, h.get(edge) ?? 0)
		if (both >= MIN_SAMPLES && both > best) [compared, best] = [edge, both]
	}
	return { base: top(b), head: top(h), compared }
}

// The database location a side's requests named, when they all name the same one.
function dbLocation(samples: readonly ServerSample[]): string | null {
	const named = new Set(samples.flatMap(s => (s.dbLocation ? [s.dbLocation] : [])))
	return named.size === 1 ? [...named][0] : null
}

// Query time is mostly the trip to the database, so two databases in different places cannot be compared.
export const databasesApart = (d: Pick<ServerDetail, 'dbLocation'> | undefined): boolean =>
	Boolean(d?.dbLocation?.base && d.dbLocation.head && d.dbLocation.base !== d.dbLocation.head)

// No edge reached by at least 3 requests on each side: the two sides' times include different distances.
export const edgesApart = (d: Pick<ServerDetail, 'edge'> | undefined): boolean => Boolean(d?.edge && !d.edge.compared)

const goodLoads = (side: readonly ServerLoad[]): ServerSample[] => side.filter((s): s is ServerSample => s !== null)
const sendsTiming = (s: ServerSample): boolean => s.total !== null || s.db !== null || s.queries !== null || s.isolate !== null

// Whether any good request carried Server-Timing. A site that never does cannot be told apart from static files.
export const sendsServerTiming = (samples: ServerSamples): boolean =>
	[samples.base, samples.head, samples.first?.base ?? [], samples.first?.head ?? []].some(side => goodLoads(side).some(sendsTiming))

// A side is static when it has enough good requests and none carried Server-Timing.
export function staticSides(samples: ServerSamples): StaticSides {
	const isStatic = (measured: readonly ServerLoad[], first: readonly ServerLoad[] = []): boolean =>
		goodLoads(measured).length >= MIN_SAMPLES && ![...goodLoads(first), ...goodLoads(measured)].some(sendsTiming)
	return { base: isStatic(samples.base, samples.first?.base), head: isStatic(samples.head, samples.first?.head) }
}

// The Server metric from the server time requests, or null when either side has fewer than 3 good ones, or both are static.
// A static side has no server time: it is compared by first byte and a page becoming static is an improvement, never a regression.
export function summariseServer(
	samples: ServerSamples,
	alpha: number,
	floor: Floor = FLOORS.Server,
	statics: StaticSides = { base: false, head: false },
	connections = SERVER_CONNECTIONS,
): MetricResult | null {
	if (statics.base && statics.head) return null
	const anyStatic = statics.base || statics.head
	const first = { base: goodLoads(samples.first?.base ?? []), head: goodLoads(samples.first?.head ?? []) }
	const measured = { base: goodLoads(samples.base), head: goodLoads(samples.head) }
	// Per side, since main may not send the marker yet: with it the server's word decides what was cold, without it the first byte.
	const marked = (side: 'base' | 'head'): boolean => [...first[side], ...measured[side]].some(s => s.isolate !== null)
	const split = (side: 'base' | 'head'): { warm: ServerSample[]; cold: number[] } => {
		if (statics[side]) return { warm: measured[side], cold: [] }
		if (marked(side)) {
			return {
				warm: measured[side].filter(s => s.isolate !== 'cold'),
				cold: [...first[side], ...measured[side]].filter(s => s.isolate === 'cold').map(s => s.ttfb),
			}
		}
		const limit = coldLimit(measured[side].map(s => s.ttfb))
		const warmMedian = median(measured[side].map(s => s.ttfb))
		const firstLimit = warmMedian === null ? null : Math.max(COLD.factor * warmMedian, warmMedian + COLD.plusMs)
		return {
			warm: limit === null ? measured[side] : measured[side].filter(s => s.ttfb <= limit),
			cold: [
				...(firstLimit === null ? [] : first[side].filter(s => s.ttfb > firstLimit)),
				...(limit === null ? [] : measured[side].filter(s => s.ttfb > limit)),
			].map(s => s.ttfb),
		}
	}
	const all = { base: split('base'), head: split('head') }
	// Compared through one edge: a request that reached another one (reconnecting ran out of tries) is left out.
	const edge = edgeFor(all.base.warm, all.head.warm)
	const through = (warm: ServerSample[]): ServerSample[] => (edge?.compared ? warm.filter(s => s.edge === edge.compared) : warm)
	const b = { ...all.base, warm: through(all.base.warm) }
	const h = { ...all.head, warm: through(all.head.warm) }
	if (b.warm.length < MIN_SAMPLES || h.warm.length < MIN_SAMPLES) return null
	// One test never mixes Server-Timing totals with first bytes.
	// A static side has no handler time, so both sides are compared by first byte.
	const source = !anyStatic && [...b.warm, ...h.warm].every(s => s.total !== null) ? 'server-timing' : 'ttfb'
	const value = (s: ServerSample): number => (source === 'server-timing' && s.total !== null ? s.total : s.ttfb)
	const bKept = b.warm.map(value)
	const hKept = h.warm.map(value)
	const summary = summarise(compareSamples(bKept, hKept, { alpha, ...floor }), bKept, hKept, false, false)
	// A percent of a base under the floor (a static server answering in 1 ms) means nothing.
	if (summary.baseMedian < floor.absFloor) summary.deltaPct = null
	// Requests on one connection share a server machine, and one machine can sit hundreds of ms further from the database
	// than the rest, so a verdict must also hold on the per-connection medians.
	const perConnection = (side: 'base' | 'head', warm: readonly ServerSample[]): number[] => {
		const kept = new Set(warm)
		return Array.from({ length: connections }, (_, c) =>
			median(samples[side].flatMap((s, i) => (s !== null && i % connections === c && kept.has(s) ? [value(s)] : []))),
		).filter((m): m is number => m !== null)
	}
	const bConn = perConnection('base', b.warm)
	const hConn = perConnection('head', h.warm)
	const byConnection = bConn.length >= MIN_SAMPLES && hConn.length >= MIN_SAMPLES ? compareSamples(bConn, hConn, { alpha, ...floor }) : null
	if (!anyStatic && byConnection && byConnection.verdict !== summary.verdict) summary.verdict = 'no-change'
	if (anyStatic) {
		// Static now is the improvement, whatever the test says, unless the static first byte is not lower. Static before is never a verdict.
		summary.verdict = statics.head && summary.verdict !== 'regressed' && summary.headMedian <= summary.baseMedian ? 'improved' : 'no-change'
	}
	const where = { base: dbLocation(b.warm), head: dbLocation(h.warm) }
	const located = where.base !== null || where.head !== null ? where : null
	if (databasesApart({ dbLocation: located }) || edgesApart({ edge })) summary.verdict = 'no-change'
	return {
		base: bKept,
		head: hKept,
		summary,
		server: {
			source,
			static: statics,
			db: medianPair(b.warm, h.warm, 'db'),
			queries: medianPair(b.warm, h.warm, 'queries'),
			dbLocation: located,
			edge,
			byConnection: byConnection
				? { base: bConn.map(tidy), head: hConn.map(tidy), shift: tidy(byConnection.shift), pValue: tidy(byConnection.pValue), verdict: byConnection.verdict }
				: null,
			coldStarts: {
				source: { base: marked('base') ? 'isolate' : 'outliers', head: marked('head') ? 'isolate' : 'outliers' },
				base: b.cold,
				head: h.cold,
				requests: { base: first.base.length + measured.base.length, head: first.head.length + measured.head.length },
			},
			requests: { base: samples.base, head: samples.head, first: samples.first ?? { base: [], head: [] } },
		},
	}
}

export interface BuildInput extends RunMeta {
	pages: PageInput[]
	alpha: number
	prodLoads?: number | null
	durationMs?: number | null
	generatedAt?: string | null
	bundle?: BundleSizes | null
}

export function buildResult({
	pages,
	alpha,
	prodLoads = null,
	durationMs = null,
	generatedAt = null,
	bundle = null,
	...meta
}: BuildInput): RunResult {
	// Static is only told apart from SSR when the site sends Server-Timing somewhere in the run.
	const timed = pages.some(p => p.server && sendsServerTiming(p.server))
	return {
		version: 1,
		bundle: bundle && (bundle.base !== null || bundle.head !== null) ? bundle : null,
		repo: meta.repo,
		prNumber: meta.prNumber,
		branch: meta.branch,
		headSha: meta.headSha,
		baseSha: meta.baseSha,
		baseUrl: meta.baseUrl,
		headUrl: meta.headUrl,
		prodUrl: meta.prodUrl,
		ciRunUrl: meta.ciRunUrl,
		config: meta.config,
		pages: pages.map(p => {
			const page = summarisePage(p.path, p.loads, alpha)
			const statics = p.server && timed ? staticSides(p.server) : { base: false, head: false }
			const server = p.server ? summariseServer(p.server, alpha, undefined, statics) : null
			if (server) page.metrics.Server = server
			return { ...page, failures: p.failures, serverFailures: p.server?.failures ?? null, serverStatic: statics.base && statics.head }
		}),
		meta: { alpha, prodLoads, durationMs, generatedAt },
	}
}

// ---- comment -------------------------------------------------------------------------------------------

const MINUS = '−'
// Non-breaking space: keeps "2.40 s" on one line in narrow table cells on GitHub mobile.
const NBSP = ' '
const SIDES: readonly SideName[] = ['base', 'head', 'prod']
const SIDE_LABEL: Record<SideName, string> = { base: 'main', head: 'this PR', prod: 'prod' }
const VERDICT_RANK: Record<Verdict, number> = { regressed: 0, improved: 1, 'no-change': 2 }
export const ACTION_URL = 'https://github.com/usero-feedback/pr-checks'

const metricEntries = (page: Pick<PageResult, 'metrics'>): [MetricName, MetricResult][] =>
	METRICS.flatMap(metric => {
		const m = page.metrics[metric]
		return m ? [[metric, m] as [MetricName, MetricResult]] : []
	})

export function formatValue(metric: MetricName, v: number | null | undefined): string {
	if (typeof v !== 'number' || !Number.isFinite(v)) return 'n/a'
	if (metric === 'CLS') return v.toFixed(3)
	return Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(2)}${NBSP}s` : `${Math.round(v)}${NBSP}ms`
}

// "+505 ms (+21%)". No percent for CLS (tiny bases) or a zero base (deltaPct null), no sign on a rounded zero.
export function formatChange(metric: MetricName, base: number, head: number, deltaPct: number | null): string {
	const zero = formatValue(metric, 0)
	const abs = formatValue(metric, Math.abs(head - base))
	if (abs === zero) return abs
	const signed = `${head > base ? '+' : MINUS}${abs}`
	if (metric === 'CLS' || deltaPct === null) return signed
	const pct = Math.round(deltaPct)
	return `${signed} (${pct > 0 ? '+' : pct < 0 ? MINUS : ''}${Math.abs(pct)}%)`
}

const code = (path: string): string => `\`${path}\``
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function listJoin(items: readonly string[]): string {
	if (items.length <= 1) return items.join('')
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

const comparedPages = (result: RunResult): PageResult[] => result.pages.filter(p => Object.keys(p.metrics).length > 0)

function pageRank(page: PageResult): number {
	return Math.min(2, ...metricEntries(page).map(([, m]) => VERDICT_RANK[m.summary.verdict]))
}

// FCP within the floor of LCP on both sides, with the same verdict, only repeats the LCP row (pages whose LCP is text).
export function fcpRepeatsLcp(page: Pick<PageResult, 'metrics'>): boolean {
	const fcp = page.metrics.FCP?.summary
	const lcp = page.metrics.LCP?.summary
	if (!fcp || !lcp || fcp.verdict !== lcp.verdict) return false
	const near = (a: number, b: number): boolean => Math.abs(a - b) < FLOORS.FCP.absFloor
	return near(fcp.baseMedian, lcp.baseMedian) && near(fcp.headMedian, lcp.headMedian)
}

// What the comment reports: regressions first, then improvements, then the rest, each in METRICS order.
function sortedMetrics(page: PageResult): [MetricName, MetricResult][] {
	const repeat = fcpRepeatsLcp(page)
	return metricEntries(page)
		.filter(([metric]) => !CONTEXT_ONLY.includes(metric) && !(repeat && metric === 'FCP'))
		.sort(([a, x], [b, y]) => VERDICT_RANK[x.summary.verdict] - VERDICT_RANK[y.summary.verdict] || METRICS.indexOf(a) - METRICS.indexOf(b))
}

// The change a verdict is about: for LCP and FCP their time after the first byte, otherwise the raw medians.
function tested(metric: MetricName, s: MetricSummary): FromFirstByte & { change: string } {
	const t = s.fromFirstByte ?? s
	return { baseMedian: t.baseMedian, headMedian: t.headMedian, deltaPct: t.deltaPct, change: formatChange(metric, t.baseMedian, t.headMedian, t.deltaPct) }
}

type Significant = Exclude<Verdict, 'no-change'>

interface Flag {
	page: PageResult
	metric: MetricName
	result: MetricResult
	verdict: Significant
}

function flagged(pages: readonly PageResult[], verdict: Significant): Flag[] {
	return pages.flatMap(page =>
		sortedMetrics(page)
			.filter(([, m]) => m.summary.verdict === verdict)
			.map(([metric, result]) => ({ page, metric, result, verdict })),
	)
}

// The word always says the direction, so no reader has to decode a sign. CLS is a score, not a time.
export function directionWord(metric: MetricName, verdict: Significant): string {
	if (metric === 'CLS') return verdict === 'regressed' ? 'worse' : 'better'
	return verdict === 'regressed' ? 'slower' : 'faster'
}

const capitalise = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`
// Plain spaces: a code block keeps them, and email clients copy them cleanly.
const plainValue = (metric: MetricName, v: number): string => formatValue(metric, v).replaceAll(NBSP, ' ')

// "- LCP  /docs  579 ms slower (26%)": regressions on red "-" lines, improvements on green "+" lines on github.com,
// plain monospace in email. Sizes are unsigned; the word carries the direction.
function diffBlock(flags: readonly Flag[]): string[] {
	const rows = flags.map(f => {
		const t = tested(f.metric, f.result.summary)
		const pct = f.metric === 'CLS' || t.deltaPct === null ? '' : ` (${Math.abs(Math.round(t.deltaPct))}%)`
		return {
			sign: f.verdict === 'regressed' ? '-' : '+',
			metric: f.metric,
			path: f.page.path,
			size: plainValue(f.metric, Math.abs(t.headMedian - t.baseMedian)),
			rest: `${directionWord(f.metric, f.verdict)}${pct}`,
		}
	})
	const width = (key: 'metric' | 'path' | 'size'): number => Math.max(...rows.map(r => r[key].length))
	const [mw, pw, sw] = [width('metric'), width('path'), width('size')]
	const lines = rows.map(r => `${r.sign} ${r.metric.padEnd(mw)}  ${r.path.padEnd(pw)}  ${r.size.padStart(sw)} ${r.rest}`)
	return ['```diff', ...lines, '```']
}

export function countVerdicts(result: RunResult): { regressions: number; improvements: number } {
	const pages = comparedPages(result)
	return { regressions: flagged(pages, 'regressed').length, improvements: flagged(pages, 'improved').length }
}

// What decides a new comment instead of an edit: the set of regressions, or a run that could not compare.
export function verdictKey(result: RunResult | null): string {
	if (!result) return 'not-measured'
	const pages = comparedPages(result)
	if (pages.length === 0) return 'not-compared'
	const regressions = flagged(pages, 'regressed').map(f => `${f.metric}:${encodeURIComponent(f.page.path)}`)
	return regressions.length === 0 ? 'clean' : `regressed ${regressions.sort().join(' ')}`
}

export function commentTitle(result: RunResult): string {
	const compared = comparedPages(result).length
	if (compared === 0) return 'Lab web vitals: could not compare with main'
	const { regressions, improvements } = countVerdicts(result)
	const parts: string[] = []
	if (regressions > 0) parts.push(plural(regressions, 'regression'))
	if (improvements > 0) parts.push(plural(improvements, 'improvement'))
	const verdict = parts.length > 0 ? parts.join(', ') : 'no significant change'
	const skipped = result.pages.length - compared
	return `Lab web vitals: ${verdict} vs main${skipped > 0 ? `, ${plural(skipped, 'page')} not compared` : ''}`
}

// Loads per page on one side: every round for main and the PR, fewer for prod.
const sideLoads = (result: RunResult, side: SideName): number =>
	side === 'prod' ? (result.meta.prodLoads ?? result.config.pairs) : result.config.pairs

interface Gap {
	line: string
	// A prod failure never touches the verdict, so it waits in the fold.
	prodOnly: boolean
}

function gapLines(result: RunResult): Gap[] {
	const loads = result.config.pairs
	const lines: Gap[] = []
	const push = (line: string, prodOnly = false): void => {
		lines.push({ line, prodOnly })
	}
	for (const page of result.pages) {
		const failures = SIDES.flatMap(side => {
			const errors = page.failures[side]
			return errors && errors.length > 0 ? [[side, errors] as const] : []
		})
		const failed = ([side, errors]: readonly [SideName, string[]]): string =>
			`${SIDE_LABEL[side]} failed ${errors.length} of ${sideLoads(result, side)} loads (${[...new Set(errors)].join('; ')})`
		if (Object.keys(page.metrics).length === 0) {
			// Lead with why the page was skipped: the sides that ran short of good loads.
			const short = failures.filter(([side, errors]) => side !== 'prod' && loads - errors.length < MIN_SAMPLES)
			const why = short.length > 0 ? listJoin(short.map(failed)) : `no metric was reported by ${MIN_SAMPLES} loads on both sides`
			push(`- ${code(page.path)} was not compared: ${why}.`)
			for (const f of failures.filter(f => !short.includes(f))) push(`- ${code(page.path)}: ${failed(f)}.`, f[0] === 'prod')
			for (const line of serverGapLines(page, result.config.serverRequests)) push(line)
			continue
		}
		for (const f of failures) push(`- ${code(page.path)}: ${failed(f)}.`, f[0] === 'prod')
		for (const d of page.dropped) {
			const short = (['base', 'head'] as const)
				.filter(side => d[side] < MIN_SAMPLES)
				.map(side => `${d[side]} of ${loads} loads on ${SIDE_LABEL[side]}`)
			push(`- ${d.metric} on ${code(page.path)} was left out: only ${listJoin(short)} reported it, ${MIN_SAMPLES} needed.`)
		}
		for (const line of serverGapLines(page, result.config.serverRequests)) push(line)
	}
	return lines
}

function serverGapLines(page: PageResult, requests: number): string[] {
	const failures = page.serverFailures
	if (!failures) return []
	const sides = (['base', 'head'] as const).filter(side => failures[side].length > 0)
	const failed = (side: 'base' | 'head'): string =>
		`${SIDE_LABEL[side]} failed ${failures[side].length} of ${requests} requests (${[...new Set(failures[side])].join('; ')})`
	if (!page.metrics.Server && !page.serverStatic) {
		const why = sides.length > 0 ? listJoin(sides.map(failed)) : `fewer than ${MIN_SAMPLES} requests succeeded`
		return [`- Server time on ${code(page.path)} was not compared: ${why}.`]
	}
	return sides.map(side => `- ${code(page.path)}: server time: ${failed(side)}.`)
}

const queryCount = (v: number | null): string => (v === null ? 'n/a' : String(Math.round(v * 10) / 10))

// Database time and queries from Server-Timing, only under a judged Server change and only when the page queries at all.
function serverDetail(d: ServerDetail, verdict: Verdict): string | null {
	if (verdict === 'no-change') return null
	const busy = (p: MedianPair | null): boolean => p !== null && ((p.baseMedian ?? 0) > 0 || (p.headMedian ?? 0) > 0)
	if (!busy(d.db) && !busy(d.queries)) return null
	const parts: string[] = []
	if (d.db) parts.push(`db ${formatValue('Server', d.db.baseMedian)} to ${formatValue('Server', d.db.headMedian)}`)
	if (d.queries) parts.push(`${queryCount(d.queries.baseMedian)} to ${queryCount(d.queries.headMedian)} queries`)
	return `Server ${parts.join(', ')}`
}

// Two databases in different places: both times stay in the row, and this says why it has no verdict.
function databasesApartDetail(d: ServerDetail): string | null {
	if (edgesApart(d) && d.edge) return `Server requests reached main through ${d.edge.base} and this PR through ${d.edge.head}, so server time is not judged`
	if (!databasesApart(d) || !d.dbLocation) return null
	const db = d.db ? ` (db ${formatValue('Server', d.db.baseMedian)} to ${formatValue('Server', d.db.headMedian)})` : ''
	return `Database in ${d.dbLocation.base} on main and ${d.dbLocation.head} on this PR${db}, so server time is not judged`
}

// Cold starts, measured but never judged: too few land per run for a test. Null when neither side had one.
function coldStartDetail(c: ColdStarts): string | null {
	if (c.base.length === 0 && c.head.length === 0) return null
	const at = (values: number[]): string => (values.length > 0 ? formatValue('Server', median(values)) : 'none')
	const counts =
		c.requests.base === c.requests.head
			? `${c.base.length} and ${c.head.length} of ${c.requests.base}`
			: `${c.base.length} of ${c.requests.base} and ${c.head.length} of ${c.requests.head}`
	return `Cold starts ${at(c.base)} to ${at(c.head)} (${counts}), not judged`
}

// How far the first byte moved the full paint medians: LCP and FCP are judged after it. Null under the floor.
function firstByteGap(metric: MetricName, s: MetricSummary): number | null {
	if (!s.fromFirstByte) return null
	const gap = s.headMedian - s.baseMedian - (s.fromFirstByte.headMedian - s.fromFirstByte.baseMedian)
	return Math.abs(gap) < FLOORS[metric].absFloor ? null : gap
}

// "First byte +312 ms, left out of LCP and FCP": why main and this PR can be far apart while Change is small.
function firstByteDetail(rows: readonly [MetricName, MetricResult][]): string | null {
	const gaps = rows.flatMap(([metric, m]) => {
		const gap = firstByteGap(metric, m.summary)
		return gap === null ? [] : [[metric, gap] as const]
	})
	if (gaps.length === 0) return null
	const gap = gaps[0][1]
	return `First byte ${gap > 0 ? '+' : MINUS}${formatValue('TTFB', Math.abs(gap))}, left out of ${listJoin(gaps.map(([metric]) => metric))}`
}

export function formatBytes(bytes: number): string {
	const abs = Math.abs(bytes)
	if (abs >= 1e6) return `${(bytes / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}${NBSP}MB`
	if (abs >= 1e3) return `${Math.round(bytes / 1e3)}${NBSP}KB`
	return `${Math.round(bytes)}${NBSP}B`
}

// The server bundle is what a cold start loads and evaluates, so its growth is the leading cold start regression.
function bundleLine({ base, head }: BundleSizes): string {
	if (base === null || head === null) {
		const [size, side, other] = base === null ? [head, 'this PR', 'main'] : [base, 'main', 'this PR']
		return `Server bundle ${size === null ? 'n/a' : formatBytes(size)} on ${side}, ${other}'s size not given.`
	}
	const diff = head - base
	if (diff === 0) return `Server bundle ${formatBytes(base)}, no change.`
	const sign = diff > 0 ? '+' : MINUS
	const pct = base > 0 ? `, ${sign}${Math.abs((diff / base) * 100).toFixed(1)}%` : ''
	return `Server bundle ${formatBytes(base)} to ${formatBytes(head)} (${sign}${formatBytes(Math.abs(diff))}${pct}), not judged.`
}

// A quiet row where both sides read zero (no shift, no blocking, no server work) says nothing.
const allZero = (metric: MetricName, s: MetricSummary): boolean =>
	s.verdict === 'no-change' && [s.baseMedian, s.headMedian].every(v => formatValue(metric, v) === formatValue(metric, 0))

// Four short columns so it fits a phone; only significant rows get a word, in bold. Notes that explain a row (first byte,
// database time, cold starts) and prod's medians sit in one full-width block under the table, never inside a cell.
function pageTable(page: PageResult, hasProd: boolean): string[] {
	const header = ['Metric', 'main', `this${NBSP}PR`, 'Change']
	const shown = sortedMetrics(page).filter(([metric, m]) => !allZero(metric, m.summary))
	const rows = shown.map(([metric, m]) => {
		const s = m.summary
		const t = tested(metric, s)
		const st = m.server?.static
		// A percent only where the change counts; on a quiet row it is noise and wraps the cell on a phone.
		let change =
			s.verdict === 'no-change'
				? formatChange(metric, t.baseMedian, t.headMedian, null)
				: `**${capitalise(directionWord(metric, s.verdict))}** ${t.change}`
		// A static side's first byte is not server time, so a page that stopped being static gets no verdict and no sign.
		if ((st?.base && !st.head) || databasesApart(m.server) || edgesApart(m.server)) change = 'not judged'
		const cell = (side: 'base' | 'head', v: number): string => `${formatValue(metric, v)}${st?.[side] ? `${NBSP}(static)` : ''}`
		return `| ${[metric, cell('base', s.baseMedian), cell('head', s.headMedian), change].join(' | ')} |`
	})
	const server = page.metrics.Server
	const st = server?.server?.static
	const oneSided = st !== undefined && st.base !== st.head
	const staticNote = oneSided ? (st.head ? 'Server now static' : 'Server no longer static') : null
	const prod = shown.flatMap(([metric, m]) => {
		const v = m.summary.vsProd?.prodMedian
		return typeof v === 'number' && Number.isFinite(v) ? [`${metric} ${formatValue(metric, v)}`] : []
	})
	const notes = [
		firstByteDetail(shown),
		staticNote,
		server?.server && !oneSided ? serverDetail(server.server, server.summary.verdict) : null,
		server?.server ? databasesApartDetail(server.server) : null,
		server?.server ? coldStartDetail(server.server.coldStarts) : null,
		hasProd && prod.length > 0 ? `prod for reference: ${prod.join(', ')}` : null,
	].filter((n): n is string => n !== null)
	const lines = [`**${code(page.path)}**`, '', `| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows]
	if (notes.length > 0) lines.push('', `<sub>${notes.join('<br>')}</sub>`)
	return lines
}

// main's preview can run commits this PR's build lacks; a change they made would read as this PR's.
function aheadLine({ commits }: BaseAhead): string {
	return `<sub>main is ${plural(commits, 'commit')} past this PR's base, and its preview may already run them, so a change above can be theirs. Merge main and push to compare like for like.</sub>`
}

export interface CommentOptions {
	// The job fails on a regression (fail-on-regression: true).
	failOnRegression?: boolean
	// main's past medians per page and metric. Without them, or with too few runs, the comment has no chart.
	history?: History
	chartBaseUrl?: string
}

const MAX_CHARTS = 3

// One trend chart per page with a significant change, of its first flagged metric. A quiet run has none.
function charts(flags: readonly Flag[], history: History | undefined, baseUrl: string | undefined): string[] {
	if (!history) return []
	const picks: [PageResult, MetricName][] = []
	for (const f of flags) if (!picks.some(([page]) => page === f.page)) picks.push([f.page, f.metric])
	return picks.slice(0, MAX_CHARTS).flatMap(([page, metric]) => {
		const series = history[page.path]?.[metric]
		const current = page.metrics[metric]?.summary.headMedian ?? null
		const img = series ? chartImage({ metric, page: page.path, series, current, baseUrl }) : null
		return img ? [img, ''] : []
	})
}

export function renderComment(result: RunResult, { failOnRegression = false, history, chartBaseUrl }: CommentOptions = {}): string {
	const { config } = result
	const hasProd = Boolean(result.prodUrl)
	const pages = comparedPages(result).sort((a, b) => pageRank(a) - pageRank(b))
	const flags = [...flagged(pages, 'regressed'), ...flagged(pages, 'improved')]
	const lines = [`### ${commentTitle(result)}`, '']

	// Above the fold: the title, and the changes when there are any. Everything else is in the fold.
	if (flags.length > 0) lines.push(...diffBlock(flags), '')
	const ahead = flags.length > 0 && result.baseAhead && result.baseAhead.commits > 0 ? result.baseAhead : null
	if (ahead) lines.push(aheadLine(ahead), '')

	// What main or this PR could not measure can hide a regression, so it stays in view; prod failures fold away.
	const gaps = gapLines(result)
	const incomplete = (list: Gap[]): string[] => (list.length > 0 ? ['**Incomplete data**', '', ...list.map(g => g.line), ''] : [])
	const folded = pages.length > 0 ? gaps.filter(g => g.prodOnly) : []
	lines.push(...incomplete(gaps.filter(g => !folded.includes(g))))
	if (pages.length > 0) {
		lines.push(`<details${flags.length > 0 ? ' open' : ''}>`, `<summary>All metrics, ${config.pairs} ${config.device} loads per side</summary>`, '')
		lines.push(...charts(flags, history, chartBaseUrl))
		for (const page of pages) lines.push(...pageTable(page, hasProd), '')
		if (result.bundle) lines.push(bundleLine(result.bundle), '')
		if (ahead && ahead.titles.length > 0) lines.push(`<sub>Newest on main since this PR's base: ${ahead.titles.map(t => `"${t}"`).join(', ')}.</sub>`, '')
		if (folded.length > 0) lines.push(...folded.map(g => g.line), '')
		lines.push('</details>', '')
	}
	lines.push(`<sub>${commentFooter(failOnRegression, result.ciRunUrl, result.headSha)}</sub>`)
	return `${lines.join('\n').trimEnd()}\n`
}

export const METHOD_URL = `${ACTION_URL}#method`

// One line: what the check does to the build, where the method lives, and the run behind these numbers.
export function commentFooter(failOnRegression: boolean, ciRunUrl: string | null, headSha?: string | null): string {
	const parts = [failOnRegression ? 'Fails the job on a regression.' : 'Report only.', `[How this is measured](${METHOD_URL}).`]
	if (ciRunUrl) parts.push(`[CI run](${ciRunUrl})${headSha ? ` for ${code(headSha.slice(0, 7))}` : ''}.`)
	return parts.join(' ')
}
