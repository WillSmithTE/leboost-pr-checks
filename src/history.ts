// main's recent medians for the trend chart, read back from the vitals.json artifact each earlier run uploaded.
import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import type { History } from './chart'
import { type DeviceName, METRICS, type MetricName } from './config'
import { at, type GitHubApi, isRecord, posInt, str } from './github'
import type { RunResult } from './report'

// Points on the chart, this run's main included; past runs fill the rest.
export const MAX_RUNS = 20
// Artifact downloads per run, newest first, so a few unusable ones still leave a full chart.
export const MAX_DOWNLOADS = 20
const PARALLEL_DOWNLOADS = 5
// A vitals.json is tens of KB; anything far bigger is not ours.
const MAX_ZIP_BYTES = 5_000_000
const MAX_JSON_BYTES = 20_000_000
const VITALS_FILE = 'vitals.json'

// main's median per page path and metric in one past run.
export type RunMedians = Record<string, Partial<Record<MetricName, number>>>

export interface Setup {
	device: DeviceName
	baseUrl: string
}

// Stable across runs and distinct per device and base URL, so each setup reads back only its own history.
export function artifactName({ device, baseUrl }: Setup): string {
	const base = new URL(baseUrl)
	const hash = createHash('sha256').update(`${base.host}${base.pathname.replace(/\/+$/, '')}`).digest('hex').slice(0, 10)
	return `usero-pr-checks-${device}-${hash}`
}

// The one file in an artifact zip; null when the zip is malformed or the file is missing.
export function unzipFile(zip: Uint8Array, name: string): Uint8Array | null {
	try {
		return readZipEntry(zip, name)
	} catch {
		// Offsets past the end, or a deflate stream that is corrupt or too large.
		return null
	}
}

function readZipEntry(zip: Uint8Array, name: string): Uint8Array | null {
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
	const u32 = (o: number): number => view.getUint32(o, true)
	const u16 = (o: number): number => view.getUint16(o, true)
	// The end-of-central-directory record sits in the last 22 bytes plus an optional comment of up to 64 KB.
	let eocd = -1
	for (let o = zip.length - 22; o >= Math.max(0, zip.length - 22 - 0xffff); o--) {
		if (u32(o) === 0x06054b50) {
			eocd = o
			break
		}
	}
	if (eocd < 0) return null
	let entry = u32(eocd + 16)
	const entries = u16(eocd + 10)
	for (let i = 0; i < entries && entry + 46 <= zip.length; i++) {
		if (u32(entry) !== 0x02014b50) return null
		const method = u16(entry + 10)
		const compressed = u32(entry + 20)
		const size = u32(entry + 24)
		const nameLength = u16(entry + 28)
		const header = u32(entry + 42)
		const entryName = new TextDecoder().decode(zip.subarray(entry + 46, entry + 46 + nameLength))
		if (entryName === name) {
			if (size > MAX_JSON_BYTES || header + 30 > zip.length || u32(header) !== 0x04034b50) return null
			const start = header + 30 + u16(header + 26) + u16(header + 28)
			const data = zip.subarray(start, start + compressed)
			if (data.length !== compressed) return null
			if (method === 0) return data
			if (method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: MAX_JSON_BYTES }))
			return null
		}
		entry += 46 + nameLength + u16(entry + 30) + u16(entry + 32)
	}
	return null
}

// main's medians from a past vitals.json, or null when it was measured some other way and is not comparable.
export function readMedians(json: unknown, device: DeviceName): RunMedians | null {
	if (at(json, 'version') !== 1 || at(json, 'config', 'device') !== device) return null
	const pages = at(json, 'pages')
	if (!Array.isArray(pages)) return null
	const medians: RunMedians = {}
	for (const page of pages) {
		const path = str(at(page, 'path'))
		if (!path) continue
		const values: Partial<Record<MetricName, number>> = {}
		for (const metric of METRICS) {
			const v = at(page, 'metrics', metric, 'summary', 'baseMedian')
			if (typeof v === 'number' && Number.isFinite(v) && v >= 0) values[metric] = v
		}
		medians[path] = values
	}
	return Object.keys(medians).length > 0 ? medians : null
}

interface Candidate {
	id: number
	runId: number
	createdAt: string
}

function candidates(data: unknown, currentRunId: number | null): Candidate[] {
	const list = at(data, 'artifacts')
	if (!Array.isArray(list)) return []
	const seen = new Set<number>()
	const out: Candidate[] = []
	for (const a of list) {
		const id = posInt(at(a, 'id'))
		const runId = posInt(at(a, 'workflow_run', 'id'))
		const createdAt = str(at(a, 'created_at'))
		const size = at(a, 'size_in_bytes')
		if (id === null || runId === null || createdAt === null || at(a, 'expired') === true) continue
		if (runId === currentRunId || seen.has(runId) || typeof size !== 'number' || size > MAX_ZIP_BYTES) continue
		seen.add(runId)
		out.push({ id, runId, createdAt })
	}
	return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_DOWNLOADS)
}

export interface LoadHistory {
	api: GitHubApi | null
	repo: string | null
	runId: number | null
	setup: Setup
}

export interface PastRuns {
	// Oldest first.
	runs: RunMedians[]
	// The one log line saying what happened.
	note: string
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = []
	for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
	return out
}

async function download(api: GitHubApi, repo: string, candidate: Candidate, setup: Setup): Promise<RunMedians | null> {
	try {
		const { bytes } = await api.download(`/repos/${repo}/actions/artifacts/${candidate.id}/zip`, MAX_ZIP_BYTES)
		const file = bytes ? unzipFile(bytes, VITALS_FILE) : null
		if (!file) return null
		const json: unknown = JSON.parse(new TextDecoder().decode(file))
		return readMedians(json, setup.device)
	} catch {
		return null
	}
}

const NO_CHART = 'Trend chart: none on this run,'

// Never throws: no history, no permission or an API error only means no chart.
export async function loadPastRuns({ api, repo, runId, setup }: LoadHistory): Promise<PastRuns> {
	if (!api || !repo) return { runs: [], note: `${NO_CHART} there is no github-token to read past runs with.` }
	const name = artifactName(setup)
	try {
		const { status, data } = await api.request('GET', `/repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`)
		if (status === 401 || status === 403 || status === 404) {
			return { runs: [], note: `${NO_CHART} the token cannot read workflow artifacts (HTTP ${status}). Add \`actions: read\` to the job's permissions.` }
		}
		if (status !== 200) return { runs: [], note: `${NO_CHART} listing past runs failed (HTTP ${status}).` }
		const picked = candidates(data, runId)
		const results = await inBatches(picked, PARALLEL_DOWNLOADS, c => download(api, repo, c, setup))
		const runs = results.filter((r): r is RunMedians => r !== null).slice(0, MAX_RUNS - 1).reverse()
		const unusable = picked.length - results.filter(r => r !== null).length
		const skipped = unusable > 0 ? ` (${unusable} unreadable or measured differently, skipped)` : ''
		if (runs.length === 0) return { runs, note: `${NO_CHART} no earlier run of this setup has results yet${skipped}.` }
		return { runs, note: `Trend chart: main's history from ${runs.length} earlier ${runs.length === 1 ? 'run' : 'runs'}${skipped}.` }
	} catch (err) {
		return { runs: [], note: `${NO_CHART} reading past runs failed: ${err instanceof Error ? err.message : String(err)}.` }
	}
}

// Past runs plus this run's main as the newest point, per page and metric; leading runs without the metric are left off.
export function buildHistory(past: readonly RunMedians[], result: RunResult): History {
	const history: Record<string, Partial<Record<MetricName, (number | null)[]>>> = {}
	for (const page of result.pages) {
		const series: Partial<Record<MetricName, (number | null)[]>> = {}
		for (const metric of METRICS) {
			const current = page.metrics[metric]?.summary.baseMedian
			if (typeof current !== 'number' || !Number.isFinite(current)) continue
			const values = [...past.map(run => run[page.path]?.[metric] ?? null), current]
			series[metric] = values.slice(values.findIndex(v => v !== null))
		}
		history[page.path] = series
	}
	return history
}
