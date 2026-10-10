// Trend chart URLs: main's history for one metric on one page, drawn statelessly by usero.io from the query.
// Format and visual spec: docs/chart-spec.md.
import type { MetricName } from './config'

export const CHART_BASE_URL = 'https://usero.io/pr-checks/chart.png'
export const CHART_VERSION = 1
// Display width in the comment; the PNG is twice that for sharp phones.
export const CHART_WIDTH = 520
export const MAX_POINTS = 30
export const MIN_POINTS = 3
export const MAX_PAGE_CHARS = 60
export const MAX_URL_CHARS = 1500
const MAX_UNITS = 99999

// main's median for this page and metric in past runs, oldest first; null where a run has no value.
export type Series = readonly (number | null)[]
// Per page path, per metric.
export type History = Readonly<Record<string, Partial<Record<MetricName, Series>>>>

export interface ChartInput {
	metric: MetricName
	page: string
	series: Series
	// This PR's median, drawn apart from main's line.
	current: number | null
	baseUrl?: string
}

const isNumber = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)

// Timings travel in tens of ms, CLS in thousandths, so every value is a short integer.
export const toUnits = (metric: MetricName, v: number): number =>
	Math.min(MAX_UNITS, Math.max(0, Math.round(metric === 'CLS' ? v * 1000 : v / 10)))
export const fromUnits = (metric: MetricName, u: number): number => (metric === 'CLS' ? u / 1000 : u * 10)

export function pageLabel(page: string): string {
	return page.length > MAX_PAGE_CHARS ? `${page.slice(0, MAX_PAGE_CHARS - 3)}...` : page
}

// Null when there are too few past runs to draw a line.
export function chartUrl({ metric, page, series, current, baseUrl = CHART_BASE_URL }: ChartInput): string | null {
	let points = series.slice(-MAX_POINTS).map(v => (isNumber(v) ? String(toUnits(metric, v)) : '_'))
	if (points.filter(p => p !== '_').length < MIN_POINTS) return null
	const build = (): string => {
		const query = [`v=${CHART_VERSION}`, `m=${metric}`, `p=${encodeURIComponent(pageLabel(page))}`, `s=${points.join('.')}`]
		if (isNumber(current)) query.push(`c=${toUnits(metric, current)}`)
		return `${baseUrl}?${query.join('&')}`
	}
	let url = build()
	// Only a very long base URL gets here; the oldest runs go first.
	while (url.length > MAX_URL_CHARS && points.length > MIN_POINTS) {
		points = points.slice(1)
		url = build()
	}
	return url
}

function plain(metric: MetricName, v: number): string {
	if (metric === 'CLS') return v.toFixed(3)
	return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`
}

// The image's alt text: the same story in words, for blocked images and screen readers.
export function chartAlt({ metric, page, series, current }: Omit<ChartInput, 'baseUrl'>): string {
	const runs = series.slice(-MAX_POINTS)
	const values = runs.filter(isNumber).map(v => fromUnits(metric, toUnits(metric, v)))
	const latest = values[values.length - 1]
	const low = Math.min(...values)
	const high = Math.max(...values)
	const range = low === high ? `held at ${plain(metric, low)}` : `ranged ${plain(metric, low)} to ${plain(metric, high)}, latest ${plain(metric, latest)}`
	const pr = isNumber(current) ? ` This PR: ${plain(metric, fromUnits(metric, toUnits(metric, current)))}.` : ''
	return `${metric} on ${pageLabel(page)}, main's last ${runs.length} runs ${range}.${pr}`
}

const escapeAttr = (s: string): string => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

// The <img> for the comment, or null when there is no chart to draw.
export function chartImage(input: ChartInput): string | null {
	const url = chartUrl(input)
	if (!url) return null
	return `<img src="${escapeAttr(url)}" width="${CHART_WIDTH}" alt="${escapeAttr(chartAlt(input))}">`
}
