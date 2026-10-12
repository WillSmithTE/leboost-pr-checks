// Reference renderer for the PR checks trend chart: query string in, SVG out. Spec: docs/chart-spec.md.
// usero.io rasterises this SVG with resvg-wasm at 2x; nothing here needs a browser or system fonts.

export const METRICS = ['LCP', 'FCP', 'CLS', 'TBT', 'TTFB', 'Server', 'INP'] as const
export type Metric = (typeof METRICS)[number]

export interface ChartData {
	metric: Metric
	page: string
	// main's medians, oldest first, in ms (CLS as the score); null where a run had no value.
	series: (number | null)[]
	current: number | null
}

export const W = 520
export const H = 240
const MAX_POINTS = 30
const MAX_UNITS = 99999
const TITLE_CHARS = 30

export const COLOR = {
	card: '#FFFFFF',
	border: '#E4E6E3',
	ink: '#0D2433',
	muted: '#5F6D78',
	grid: '#E4E6E3',
	accent: '#FF5A1F',
	band: '#FFF1EB',
	gap: '#B4BCC2',
} as const
export const FONT = "'Atkinson Hyperlegible', sans-serif"

const PLOT_TOP = 70
const PLOT_BOTTOM = 172
// Tick labels end at GRID_LEFT - 8, so the widest (about 53 px, "800 ms") starts at x 21, in line with the title.
const GRID_LEFT = 82
const GRID_RIGHT = 500
const MAIN_LEFT = 90
const MAIN_RIGHT = 400
const PR_X = 462
const BOTTOM_LABEL_Y = 222

// Narrowest y range per metric, so run-to-run noise draws as a wobble rather than a cliff.
const MIN_SPAN: Record<Metric, number> = { LCP: 200, FCP: 200, TTFB: 100, Server: 100, TBT: 100, INP: 50, CLS: 0.05 }

const isMetric = (m: string | null): m is Metric => METRICS.some(x => x === m)
const fromUnits = (metric: Metric, u: number): number => (metric === 'CLS' ? u / 1000 : u * 10)

// Parses the query from chartUrl() in the Action; a string is the reason for a 400.
export function parseChartQuery(query: URLSearchParams): ChartData | string {
	if (query.get('v') !== '1') return 'unsupported version'
	const metric = query.get('m')
	if (!isMetric(metric)) return 'unknown metric'
	const page = (query.get('p') ?? '').slice(0, 60)
	const raw = (query.get('s') ?? '').split('.')
	if (raw.length > MAX_POINTS) return 'too many points'
	const units = (x: string): number | null => (/^\d{1,5}$/.test(x) ? Number(x) : null)
	const series: (number | null)[] = []
	for (const x of raw) {
		if (x === '_') series.push(null)
		else {
			const u = units(x)
			if (u === null || u > MAX_UNITS) return 'bad point'
			series.push(fromUnits(metric, u))
		}
	}
	if (series.filter(v => v !== null).length < 3) return 'needs three points'
	const c = query.get('c')
	const cu = c === null ? null : units(c)
	if (c !== null && cu === null) return 'bad current value'
	return { metric, page, series, current: cu === null ? null : fromUnits(metric, cu) }
}

function value(metric: Metric, v: number): string {
	if (metric === 'CLS') return v.toFixed(3)
	return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`
}

const NICE = [1, 2, 2.5, 5]
// Gridline counts by preference: three, then two, then four.
const LINES_RANK: Record<number, number> = { 3: 0, 2: 1, 4: 2 }

function ticksFor(lo: number, hi: number, step: number): number[] {
	const ticks: number[] = []
	for (let t = Math.ceil(lo / step - 1e-9) * step; t <= hi + 1e-9; t += step) ticks.push(Number(t.toPrecision(10)))
	return ticks
}

// The nice step (1, 2, 2.5 or 5 x 10^n) giving two to four gridlines, three when it can; the larger step on a tie.
export function niceStep(lo: number, hi: number): number {
	const power = Math.floor(Math.log10(hi - lo))
	let best = { step: 10 ** power, rank: Number.POSITIVE_INFINITY }
	for (const exp of [power - 1, power]) {
		for (const s of NICE) {
			const step = s * 10 ** exp
			if ((hi - lo) / step > 5) continue
			const rank = LINES_RANK[ticksFor(lo, hi, step).length] ?? Number.POSITIVE_INFINITY
			if (rank < best.rank || (rank === best.rank && step > best.step)) best = { step, rank }
		}
	}
	return best.step
}

const decimals = (x: number): number => {
	const s = String(Number(x.toPrecision(6)))
	return s.includes('.') ? s.length - s.indexOf('.') - 1 : 0
}

function tickLabel(metric: Metric, v: number, step: number, inSeconds: boolean): string {
	if (metric === 'CLS') return v.toFixed(Math.max(2, decimals(step)))
	if (inSeconds) return `${(v / 1000).toFixed(Math.max(1, decimals(step / 1000)))} s`
	return `${Math.round(v)} ms`
}

export interface Scale {
	lo: number
	hi: number
	ticks: number[]
	step: number
}

export function yScale(metric: Metric, values: number[], typical: number): Scale {
	const min = Math.min(...values)
	const max = Math.max(...values)
	const span = Math.max(max - min, MIN_SPAN[metric], 0.2 * typical)
	let lo = (min + max) / 2 - span / 2
	if (lo < 0) lo = 0
	const hi0 = lo + span
	const pad = span * 0.12
	lo = Math.max(0, lo - pad)
	const hi = hi0 + pad
	const step = niceStep(lo, hi)
	return { lo, hi, ticks: ticksFor(lo, hi, step), step }
}

const esc = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const r1 = (n: number): string => String(Math.round(n * 10) / 10)

function text(x: number, y: number, body: string, opts: { size: number; weight?: number; fill: string; anchor?: 'start' | 'middle' | 'end'; halo?: string }): string {
	const halo = opts.halo ? ` stroke="${opts.halo}" stroke-width="4" stroke-linejoin="round" paint-order="stroke"` : ''
	return `<text x="${r1(x)}" y="${r1(y)}" font-size="${opts.size}" font-weight="${opts.weight ?? 400}" fill="${opts.fill}" text-anchor="${opts.anchor ?? 'start'}"${halo}>${esc(body)}</text>`
}

export function renderChartSvg({ metric, page, series, current }: ChartData): string {
	const points = series.slice(-MAX_POINTS)
	const finite = points.filter((v): v is number => v !== null)
	const sorted = [...finite].sort((a, b) => a - b)
	const typical = sorted[Math.floor(sorted.length / 2)]
	const scale = yScale(metric, current === null ? finite : [...finite, current], typical)
	const y = (v: number): number => PLOT_BOTTOM - ((v - scale.lo) / (scale.hi - scale.lo)) * (PLOT_BOTTOM - PLOT_TOP)
	const x = (i: number): number => (points.length === 1 ? MAIN_RIGHT : MAIN_LEFT + (i * (MAIN_RIGHT - MAIN_LEFT)) / (points.length - 1))
	const inSeconds = metric !== 'CLS' && Math.max(...scale.ticks) >= 1000

	const out: string[] = []
	out.push(`<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="12" fill="${COLOR.card}" stroke="${COLOR.border}" stroke-width="1.5"/>`)

	// This PR's column, the one tinted area.
	if (current !== null) out.push(`<rect x="${PR_X - 30}" y="${PLOT_TOP - 14}" width="60" height="${BOTTOM_LABEL_Y + 8 - (PLOT_TOP - 14)}" rx="8" fill="${COLOR.band}"/>`)

	for (const t of scale.ticks) {
		const ty = y(t)
		out.push(`<line x1="${GRID_LEFT}" x2="${GRID_RIGHT}" y1="${r1(ty)}" y2="${r1(ty)}" stroke="${COLOR.grid}" stroke-width="1"/>`)
		out.push(text(GRID_LEFT - 8, ty + 5, tickLabel(metric, t, scale.step, inSeconds), { size: 15, fill: COLOR.muted, anchor: 'end' }))
	}

	const title = page.length > TITLE_CHARS ? `${page.slice(0, TITLE_CHARS - 3)}...` : page
	out.push(text(20, 38, `${metric} on ${title}`, { size: 20, weight: 700, fill: COLOR.ink }))

	// main's line, broken where a run has no value; a lone point between gaps is a dot.
	const segments: [number, number][][] = [[]]
	points.forEach((v, i) => {
		if (v === null) segments.push([])
		else segments[segments.length - 1].push([x(i), y(v)])
	})
	// A run with no value is bridged by a faint dotted line, so the gap reads as missing data, not a glitch.
	const drawn = segments.filter(seg => seg.length > 0)
	for (let i = 1; i < drawn.length; i++) {
		const [ax, ay] = drawn[i - 1][drawn[i - 1].length - 1]
		const [bx, by] = drawn[i][0]
		out.push(`<line x1="${r1(ax)}" y1="${r1(ay)}" x2="${r1(bx)}" y2="${r1(by)}" stroke="${COLOR.gap}" stroke-width="1.5" stroke-dasharray="1 4" stroke-linecap="round"/>`)
	}
	for (const seg of segments) {
		if (seg.length === 1) out.push(`<circle cx="${r1(seg[0][0])}" cy="${r1(seg[0][1])}" r="2.5" fill="${COLOR.ink}"/>`)
		if (seg.length > 1) {
			const d = seg.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${r1(px)} ${r1(py)}`).join(' ')
			out.push(`<path d="${d}" fill="none" stroke="${COLOR.ink}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>`)
		}
	}

	const lastIndex = points.map(v => v !== null).lastIndexOf(true)
	const last = finite[finite.length - 1]
	const lx = x(lastIndex)
	const ly = y(last)
	const prAbove = current !== null && current >= last
	if (current !== null) {
		const cy = y(current)
		out.push(`<line x1="${r1(lx)}" y1="${r1(ly)}" x2="${PR_X}" y2="${r1(cy)}" stroke="${COLOR.accent}" stroke-width="1.5" stroke-dasharray="3 4" stroke-linecap="round"/>`)
		out.push(`<circle cx="${PR_X}" cy="${r1(cy)}" r="7" fill="${COLOR.accent}" stroke="${COLOR.card}" stroke-width="2.5"/>`)
		out.push(text(PR_X, prAbove ? cy - 14 : cy + 26, value(metric, current), { size: 17, weight: 700, fill: COLOR.ink, anchor: 'middle', halo: COLOR.band }))
	}
	out.push(`<circle cx="${r1(lx)}" cy="${r1(ly)}" r="4" fill="${COLOR.ink}"/>`)
	out.push(text(lx, prAbove ? ly + 26 : ly - 14, value(metric, last), { size: 17, fill: COLOR.ink, anchor: 'middle', halo: COLOR.card }))

	out.push(text(MAIN_LEFT, BOTTOM_LABEL_Y, `main, last ${points.length} runs`, { size: 15, fill: COLOR.muted }))
	if (current !== null) out.push(text(PR_X, BOTTOM_LABEL_Y, 'this PR', { size: 15, weight: 700, fill: COLOR.ink, anchor: 'middle' }))

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`,
		...out.map(line => `  ${line}`),
		'</svg>',
		'',
	].join('\n')
}
