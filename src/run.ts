// Interleaved sampling: rounds whose side order rotates so runner drift lands on every side equally
// (AB, BA for two sides; ABC, BCA, CAB for three).
import type { MetricName } from './config'

export type SideName = 'base' | 'head' | 'prod'
// documentStart: when the page's first script ran, after the first byte and once the browser was ready to render.
export type Metrics = Partial<Record<MetricName | 'documentStart', number | null>>
// A failed load is null, kept in its round so main and PR pair up by index.
export type Load = Metrics | null

export interface Side {
	name: SideName
	url: string
	// Prod is context only: a few loads, never a verdict.
	context?: boolean
}

export interface PageSpec {
	path: string
	interaction: string | null
	// Loads the context side (prod) on this path too; false for a path not in prod-paths.
	prod: boolean
}

export type Measure = (url: string, page: PageSpec) => Promise<Metrics>
export type Log = (line: string) => void

export function roundOrder<T>(sides: readonly T[], round: number): T[] {
	return sides.map((_, i) => sides[(i + round) % sides.length])
}

// Keeps any path prefix on the base URL (https://host/app + /docs -> https://host/app/docs).
export function joinUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`
}

// The rounds a context side (prod) joins, spread evenly: 3 of 8 rounds are 1, 4 and 6.
export function contextRounds(loads: number, rounds: number): Set<number> {
	const n = Math.min(loads, rounds)
	return new Set(Array.from({ length: n }, (_, i) => Math.floor(((i + 0.5) * rounds) / n)))
}

export const firstLine = (err: unknown): string => String(err instanceof Error ? err.message : err).split('\n')[0]

// Runs fn over items with at most limit in flight, results in item order.
export async function inPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array<R>(items.length)
	let next = 0
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++
			out[i] = await fn(items[i], i)
		}
	}
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
	return out
}

// Each round's sides in order: one after another, or all started together (in the rotated order) when parallel.
export async function eachSide<T, R>(order: readonly T[], parallel: boolean, fn: (item: T) => Promise<R>): Promise<R[]> {
	return inPool(order, parallel ? order.length : 1, item => fn(item))
}

// One discarded load per side wakes cold Workers or lambdas before anything is recorded.
export async function warmUp({
	page,
	sides,
	measure,
	log,
	parallel = false,
}: {
	page: PageSpec
	sides: readonly Side[]
	measure: Measure
	log: Log
	parallel?: boolean
}) {
	await eachSide(sides, parallel, side =>
		measure(joinUrl(side.url, page.path), page).catch((err: unknown) => log(`  warm-up ${side.name} failed: ${firstLine(err)}`)),
	)
}

export interface PageSamples {
	samples: Partial<Record<SideName, Load[]>> & { base: Load[]; head: Load[] }
	failures: Partial<Record<SideName, string[]>>
}

// Sides with context: true load in only contextLoads of the rounds, and never on a page with prod: false. Returns per side
// one entry per load, null when it failed (for main and the PR the index is the round), and the failure reasons.
// parallel loads a round's sides at the same moment, so main and the PR share the runner's CPU equally.
export async function samplePage({
	page,
	sides: allSides,
	rounds,
	contextLoads = rounds,
	measure,
	log,
	parallel = false,
}: {
	page: PageSpec
	sides: readonly Side[]
	rounds: number
	contextLoads?: number
	measure: Measure
	log: Log
	parallel?: boolean
}): Promise<PageSamples> {
	const sides = page.prod ? allSides : allSides.filter(s => !s.context)
	const samples: PageSamples['samples'] = { base: [], head: [] }
	const failures: PageSamples['failures'] = {}
	for (const side of sides) {
		samples[side.name] = []
		failures[side.name] = []
	}
	const withContext = [...contextRounds(contextLoads, rounds)]
	const compared = sides.filter(s => !s.context)

	for (let round = 0; round < rounds; round++) {
		// Main and PR alternate exactly; a context load takes the first, middle or last slot in turn.
		const order = roundOrder(compared, round)
		const k = withContext.indexOf(round)
		if (k >= 0) order.splice(k % (order.length + 1), 0, ...sides.filter(s => s.context))
		const loads = await eachSide(order, parallel, side =>
			measure(joinUrl(side.url, page.path), page).then(
				(metrics): { metrics: Metrics } | { reason: string } => ({ metrics }),
				(err: unknown) => ({ reason: firstLine(err) }),
			),
		)
		order.forEach((side, i) => {
			const load = loads[i]
			if ('metrics' in load) {
				samples[side.name]?.push(load.metrics)
				log(`  ${page.path} #${round + 1} ${side.name}: ${formatMetrics(load.metrics)}`)
			} else {
				samples[side.name]?.push(null)
				failures[side.name]?.push(load.reason)
				log(`  ${page.path} #${round + 1} ${side.name}: FAILED ${load.reason}`)
			}
		})
	}
	return { samples, failures }
}

function formatMetrics(m: Metrics): string {
	return Object.entries(m)
		.filter((entry): entry is [string, number] => typeof entry[1] === 'number')
		.map(([k, v]) => `${k} ${k === 'CLS' ? v.toFixed(3) : Math.round(v)}`)
		.join(', ')
}
