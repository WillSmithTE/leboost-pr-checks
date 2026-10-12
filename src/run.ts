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

// One discarded load per side wakes cold Workers or lambdas before anything is recorded.
export async function warmUp({ page, sides, measure, log }: { page: PageSpec; sides: readonly Side[]; measure: Measure; log: Log }) {
	for (const side of sides) {
		await measure(joinUrl(side.url, page.path), page).catch((err: unknown) => log(`  warm-up ${side.name} failed: ${firstLine(err)}`))
	}
}

export interface PageSamples {
	samples: Partial<Record<SideName, Load[]>> & { base: Load[]; head: Load[] }
	failures: Partial<Record<SideName, string[]>>
}

// Sides with context: true load in only contextLoads of the rounds, and never on a page with prod: false. Returns per side
// one entry per load, null when it failed (for main and the PR the index is the round), and the failure reasons.
export async function samplePage({
	page,
	sides: allSides,
	rounds,
	contextLoads = rounds,
	measure,
	log,
}: {
	page: PageSpec
	sides: readonly Side[]
	rounds: number
	contextLoads?: number
	measure: Measure
	log: Log
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
		for (const side of order) {
			try {
				const metrics = await measure(joinUrl(side.url, page.path), page)
				samples[side.name]?.push(metrics)
				log(`  ${page.path} #${round + 1} ${side.name}: ${formatMetrics(metrics)}`)
			} catch (err) {
				const reason = firstLine(err)
				samples[side.name]?.push(null)
				failures[side.name]?.push(reason)
				log(`  ${page.path} #${round + 1} ${side.name}: FAILED ${reason}`)
			}
		}
	}
	return { samples, failures }
}

function formatMetrics(m: Metrics): string {
	return Object.entries(m)
		.filter((entry): entry is [string, number] => typeof entry[1] === 'number')
		.map(([k, v]) => `${k} ${k === 'CLS' ? v.toFixed(3) : Math.round(v)}`)
		.join(', ')
}
