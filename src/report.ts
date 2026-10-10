// Turns raw samples into the result document and the PR comment.
import { CONTEXT_ONLY, type DeviceName, FLOORS, type Floor, FROM_FIRST_BYTE, METRICS, type MetricName } from './config'
import type { Load, PageSamples, SideName } from './run'
import { chartImage, type History } from './chart'
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

export interface MetricResult {
	base: number[]
	head: number[]
	prod?: number[]
	summary: MetricSummary
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
}

export interface RunConfig {
	pairs: number
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

export interface RunResult extends RunMeta {
	version: 1
	pages: PageResult[]
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
}

type Values = (number | null | undefined)[]
const values = (loads: readonly Load[], metric: MetricName): Values => loads.map(m => m?.[metric])
const column = (loads: readonly Load[], metric: MetricName): number[] =>
	values(loads, metric).filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
const finiteCount = (xs: Values): number => xs.filter(v => typeof v === 'number' && Number.isFinite(v)).length
// Paint time after the first byte; undefined when either is missing.
const fromFirstByte = (loads: readonly Load[], metric: MetricName): Values =>
	loads.map(m => {
		const paint = m?.[metric]
		const ttfb = m?.TTFB
		return typeof paint === 'number' && Number.isFinite(paint) && typeof ttfb === 'number' && Number.isFinite(ttfb)
			? paint - ttfb
			: undefined
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
): Omit<PageResult, 'failures'> {
	const metrics: PageResult['metrics'] = {}
	const dropped: Dropped[] = []
	for (const metric of METRICS) {
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

export interface BuildInput extends RunMeta {
	pages: PageInput[]
	alpha: number
	prodLoads?: number | null
	durationMs?: number | null
	generatedAt?: string | null
}

export function buildResult({
	pages,
	alpha,
	prodLoads = null,
	durationMs = null,
	generatedAt = null,
	...meta
}: BuildInput): RunResult {
	return {
		version: 1,
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
		pages: pages.map(p => ({ ...summarisePage(p.path, p.loads, alpha), failures: p.failures })),
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

// Regressions first, then improvements, then the rest, each in METRICS order.
function sortedMetrics(page: PageResult): [MetricName, MetricResult][] {
	return metricEntries(page).sort(
		([a, x], [b, y]) => VERDICT_RANK[x.summary.verdict] - VERDICT_RANK[y.summary.verdict] || METRICS.indexOf(a) - METRICS.indexOf(b),
	)
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

function gapLines(result: RunResult): string[] {
	const loads = result.config.pairs
	const lines: string[] = []
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
			lines.push(`- ${code(page.path)} was not compared: ${why}.`)
			for (const f of failures.filter(f => !short.includes(f))) lines.push(`- ${code(page.path)}: ${failed(f)}.`)
			continue
		}
		for (const f of failures) lines.push(`- ${code(page.path)}: ${failed(f)}.`)
		for (const d of page.dropped) {
			const short = (['base', 'head'] as const)
				.filter(side => d[side] < MIN_SAMPLES)
				.map(side => `${d[side]} of ${loads} loads on ${SIDE_LABEL[side]}`)
			lines.push(`- ${d.metric} on ${code(page.path)} was left out: only ${listJoin(short)} reported it, ${MIN_SAMPLES} needed.`)
		}
	}
	return lines
}

// The PR preview's TTFB minus main's, when it moved raw LCP (else FCP) past that metric's floor; null otherwise.
function serverGap(page: PageResult): number | null {
	const ttfb = page.metrics.TTFB?.summary
	const paint = FROM_FIRST_BYTE.map(k => page.metrics[k]?.summary).find(s => s?.fromFirstByte)
	if (!ttfb || !paint) return null
	const gap = ttfb.headMedian - ttfb.baseMedian
	return Math.abs(gap) >= paint.floor ? gap : null
}

// Under a paint Change, the server time that makes up the rest of the gap between the raw medians.
// Breaks only between "plus 314 ms" and "server time" in a narrow cell.
const serverTime = (gap: number): string =>
	`<br><sub>${gap > 0 ? 'plus' : 'minus'}${NBSP}${formatValue('TTFB', Math.abs(gap))} server${NBSP}time</sub>`

// Five columns at most so it fits GitHub mobile; only significant rows get a word, in bold.
function pageTable(page: PageResult, hasProd: boolean): string[] {
	const header = ['Metric', 'main', `this${NBSP}PR`, 'Change']
	if (hasProd) header.push('prod')
	const gap = serverGap(page)
	const rows = sortedMetrics(page).map(([metric, m]) => {
		const s = m.summary
		const { change } = tested(metric, s)
		const hint = gap !== null && s.fromFirstByte ? serverTime(gap) : ''
		const word = s.verdict === 'no-change' ? '' : `**${capitalise(directionWord(metric, s.verdict))}** `
		const cells = [metric, formatValue(metric, s.baseMedian), formatValue(metric, s.headMedian), `${word}${change}${hint}`]
		if (hasProd) cells.push(formatValue(metric, s.vsProd?.prodMedian))
		return `| ${cells.join(' | ')} |`
	})
	return [`**${code(page.path)}**`, '', `| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows]
}

// One line under the headline when a preview server gap moved the raw paint medians, so the table needs no decoding.
function serverLine(pages: readonly PageResult[]): string | null {
	const gaps = pages.flatMap(page => {
		const gap = serverGap(page)
		return gap === null ? [] : [[page, gap] as const]
	})
	if (gaps.length === 0) return null
	const parts = gaps.map(
		([page, gap], i) =>
			`${formatValue('TTFB', Math.abs(gap))} ${gap > 0 ? 'slower' : 'faster'}${i === 0 ? " than main's" : ''} on ${code(page.path)}`,
	)
	return `This PR's preview server responded ${listJoin(parts)}. That is usually not the code, so it is left out of the result.`
}

export interface CommentOptions {
	// The job fails on a regression (fail-on-regression: true).
	failOnRegression?: boolean
	// main's past medians per page and metric. Without them, or with too few runs, the comment has no chart.
	history?: History
	chartBaseUrl?: string
}

const MAX_CHARTS = 3

// One trend chart per page with a significant change, of its first flagged metric; for a quiet run, LCP on the first page.
function charts(pages: readonly PageResult[], flags: readonly Flag[], history: History | undefined, baseUrl: string | undefined): string[] {
	if (!history) return []
	const picks: [PageResult, MetricName][] = []
	for (const f of flags) if (!picks.some(([page]) => page === f.page)) picks.push([f.page, f.metric])
	if (flags.length === 0 && pages.length > 0) {
		const first = pages[0]
		const metric = first.metrics.LCP ? 'LCP' : metricEntries(first)[0]?.[0]
		if (metric) picks.push([first, metric])
	}
	return picks.slice(0, MAX_CHARTS).flatMap(([page, metric]) => {
		const series = history[page.path]?.[metric]
		const current = page.metrics[metric]?.summary.headMedian ?? null
		const img = series ? chartImage({ metric, page: page.path, series, current, baseUrl }) : null
		return img ? [img, ''] : []
	})
}

export function renderComment(result: RunResult, { failOnRegression = false, history, chartBaseUrl }: CommentOptions = {}): string {
	const { config, meta } = result
	const hasProd = Boolean(result.prodUrl)
	const pages = comparedPages(result).sort((a, b) => pageRank(a) - pageRank(b))
	const regressed = flagged(pages, 'regressed')
	const improved = flagged(pages, 'improved')
	const flags = [...regressed, ...improved]
	const chartLines = charts(pages, flags, history, chartBaseUrl)
	const lines = [`### ${commentTitle(result)}`, '']

	// A quiet run stays short: no summary block, and its chart waits inside the table fold.
	if (flags.length > 0) lines.push(...diffBlock(flags), '', ...chartLines)

	const server = serverLine(pages)
	if (server) lines.push(server, '')

	// "No change" is not "proven fine": say what a run this size can miss, next to the claim.
	if (pages.length > 0 && regressed.length === 0) {
		const lead =
			improved.length > 0 ? 'No regressions.' : `Nothing on ${listJoin(pages.map(p => code(p.path)))} moved past run-to-run noise.`
		// The LCP floor is the smallest change that can count, so anything under it always slips through.
		const lcpFloors = pages.flatMap(p => {
			const floor = p.metrics.LCP?.summary.floor
			return typeof floor === 'number' && Number.isFinite(floor) ? [floor] : []
		})
		const example =
			lcpFloors.length > 0 ? `, such as an LCP change under ${formatValue('LCP', Math.round(Math.max(...lcpFloors) / 10) * 10)}` : ''
		lines.push(`${lead} With ${config.pairs} loads per side, smaller shifts can slip through${example}.`, '')
	}

	const gaps = gapLines(result)
	if (gaps.length > 0) lines.push('**Incomplete data**', '', ...gaps, '')

	if (pages.length > 0) {
		lines.push(`<details${regressed.length > 0 ? ' open' : ''}>`, '<summary>All metrics</summary>', '')
		if (flags.length === 0) lines.push(...chartLines)
		for (const page of pages) lines.push(...pageTable(page, hasProd), '')
		const fromFirstByteMetrics = METRICS.filter(k => pages.some(p => p.metrics[k]?.summary.fromFirstByte))
		if (fromFirstByteMetrics.length > 0) {
			lines.push(
				`For ${listJoin(fromFirstByteMetrics)}, Change is the time after the first byte, so server speed can neither hide nor fake a change. main and this PR show the full medians.`,
				'',
			)
		}
		const context = CONTEXT_ONLY.filter(k => pages.some(p => p.metrics[k]))
		if (context.length > 0) {
			lines.push(
				`${listJoin(context)} ${context.length === 1 ? 'is for reference and never affects' : 'are for reference and never affect'} the result. Each preview's server speed varies on its own, so a gap there is usually not this PR.`,
				'',
			)
		}
		if (hasProd) {
			lines.push(
				'prod is for reference and never affects the result. It can load third-party tags, data and caches the previews do not, so a gap there is usually not this PR.',
				'',
			)
		}
		lines.push('</details>', '')
	}

	const net = `${config.latencyMs} ms RTT, ${(config.downloadKbps / 1024).toFixed(1)} Mbps down and ${config.cpuSlowdown}x CPU`
	const sha = result.headSha ? code(result.headSha.slice(0, 7)) : null
	const prodNote = hasProd && meta.prodLoads !== null && meta.prodLoads !== config.pairs ? ` (${meta.prodLoads} on prod)` : ''
	const footer = [
		failOnRegression ? 'Fails the job on a regression.' : 'Report only, never fails the build.',
		`Medians of ${config.pairs} cold ${config.device} loads per side${prodNote}, interleaved, at ${net}.`,
		`A change counts when it is significant (one-sided Mann-Whitney, p < ${meta.alpha}) and larger than a per-metric floor.`,
	]
	if (result.ciRunUrl) footer.push(`[CI run](${result.ciRunUrl})${sha ? ` for ${sha}` : ''}.`)
	else if (sha) footer.push(`Head ${sha}.`)
	footer.push(`By [Usero PR checks](${ACTION_URL}).`)
	lines.push(`<sub>${footer.join(' ')}</sub>`)
	return `${lines.join('\n').trimEnd()}\n`
}
