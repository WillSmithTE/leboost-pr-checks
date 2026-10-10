import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { GitHubApi } from '../src/github'
import { artifactName, buildHistory, loadPastRuns, MAX_DOWNLOADS, MAX_RUNS, readMedians, type RunMedians, unzipFile } from '../src/history'
import type { MetricResult, RunResult } from '../src/report'
import { type Artifacts, saveResult } from '../src/upload'

const SETUP = { device: 'mobile' as const, baseUrl: 'https://main.app.test' }
const NAME = artifactName(SETUP)

// A zip with one entry, as actions/upload-artifact writes it (deflate), or stored.
function zip(name: string, content: string, method: 0 | 8 = 8): Uint8Array<ArrayBuffer> {
	const raw = Buffer.from(content)
	const data = method === 8 ? deflateRawSync(raw) : raw
	const fileName = Buffer.from(name)
	const local = Buffer.alloc(30)
	local.writeUInt32LE(0x04034b50, 0)
	local.writeUInt16LE(method, 8)
	local.writeUInt32LE(data.length, 18)
	local.writeUInt32LE(raw.length, 22)
	local.writeUInt16LE(fileName.length, 26)
	const central = Buffer.alloc(46)
	central.writeUInt32LE(0x02014b50, 0)
	central.writeUInt16LE(method, 10)
	central.writeUInt32LE(data.length, 20)
	central.writeUInt32LE(raw.length, 24)
	central.writeUInt16LE(fileName.length, 28)
	central.writeUInt32LE(0, 42)
	const centralOffset = local.length + fileName.length + data.length
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(1, 8)
	end.writeUInt16LE(1, 10)
	end.writeUInt32LE(central.length + fileName.length, 12)
	end.writeUInt32LE(centralOffset, 16)
	return new Uint8Array(Buffer.concat([local, fileName, data, central, fileName, end]))
}

// The parts of vitals.json the history reads.
const vitals = (lcp: number, device = 'mobile') =>
	JSON.stringify({
		version: 1,
		baseUrl: SETUP.baseUrl,
		config: { device },
		pages: [{ path: '/', metrics: { LCP: { summary: { baseMedian: lcp } }, CLS: { summary: { baseMedian: 0 } } } }],
	})

describe('artifactName', () => {
	it('is stable per device and base URL, ignoring a trailing slash', () => {
		expect(NAME).toMatch(/^usero-pr-checks-mobile-[0-9a-f]{10}$/)
		expect(artifactName({ ...SETUP, baseUrl: 'https://main.app.test/' })).toBe(NAME)
		expect(artifactName({ ...SETUP, device: 'desktop' })).not.toBe(NAME)
		expect(artifactName({ ...SETUP, baseUrl: 'https://main.app.test/app' })).not.toBe(NAME)
	})
})

describe('unzipFile', () => {
	it('reads a deflated or stored entry', () => {
		const text = (b: Uint8Array | null) => (b ? new TextDecoder().decode(b) : null)
		expect(text(unzipFile(zip('vitals.json', '{"a":1}'), 'vitals.json'))).toBe('{"a":1}')
		expect(text(unzipFile(zip('vitals.json', '{"a":2}', 0), 'vitals.json'))).toBe('{"a":2}')
	})

	it('returns null for a missing entry or a broken zip', () => {
		expect(unzipFile(zip('other.json', '{}'), 'vitals.json')).toBeNull()
		expect(unzipFile(new Uint8Array([1, 2, 3]), 'vitals.json')).toBeNull()
		const good = zip('vitals.json', vitals(2400))
		expect(unzipFile(good.subarray(10), 'vitals.json')).toBeNull()
		const corrupt = new Uint8Array(good)
		corrupt.fill(0xff, 30 + 'vitals.json'.length, 40 + 'vitals.json'.length)
		expect(unzipFile(corrupt, 'vitals.json')).toBeNull()
	})
})

describe('readMedians', () => {
	it("takes main's median per page and metric, zero included", () => {
		expect(readMedians(JSON.parse(vitals(2400)), 'mobile')).toEqual({ '/': { LCP: 2400, CLS: 0 } })
	})

	it('refuses a run measured on another device or in another format', () => {
		expect(readMedians(JSON.parse(vitals(2400, 'desktop')), 'mobile')).toBeNull()
		expect(readMedians({ version: 2, config: { device: 'mobile' }, pages: [{ path: '/' }] }, 'mobile')).toBeNull()
		expect(readMedians(null, 'mobile')).toBeNull()
	})
})

interface Call {
	url: string
	auth: string | null
}

// A GitHub API plus blob storage: artifact listing, zip redirects, and the zips themselves.
function fakeGitHub(artifacts: unknown[], zips: Record<number, Uint8Array<ArrayBuffer>>, listStatus = 200) {
	const calls: Call[] = []
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = String(input)
		const auth = new Headers(init?.headers).get('authorization')
		calls.push({ url, auth })
		if (url.includes('/actions/artifacts?')) return Response.json({ total_count: artifacts.length, artifacts }, { status: listStatus })
		const zipped = url.match(/\/actions\/artifacts\/(\d+)\/zip$/)
		if (zipped) return new Response(null, { status: 302, headers: { location: `https://blob.test/${zipped[1]}.zip` } })
		const blob = url.match(/^https:\/\/blob\.test\/(\d+)\.zip$/)
		const bytes = blob ? zips[Number(blob[1])] : undefined
		return bytes ? new Response(bytes) : new Response('gone', { status: 404 })
	}
	return { api: new GitHubApi('t0ken', 'https://api.github.com', fetchImpl), calls }
}

const artifact = (id: number, runId: number, day: number, extra: Record<string, unknown> = {}) => ({
	id,
	name: NAME,
	size_in_bytes: 900,
	expired: false,
	created_at: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`,
	workflow_run: { id: runId },
	...extra,
})

describe('loadPastRuns', () => {
	it('reads earlier runs oldest first, skipping this run, expired and unusable artifacts', async () => {
		const { api, calls } = fakeGitHub(
			[
				artifact(3, 300, 3),
				artifact(1, 100, 1),
				artifact(9, 900, 9),
				artifact(2, 200, 2, { expired: true }),
				artifact(4, 400, 4),
				artifact(5, 500, 5),
			],
			{ 1: zip('vitals.json', vitals(2410)), 3: zip('vitals.json', vitals(2430)), 4: zip('vitals.json', vitals(2400, 'desktop')), 9: zip('x', '') },
		)
		const past = await loadPastRuns({ api, repo: 'acme/shop', runId: 900, setup: SETUP })
		expect(past.runs).toEqual([{ '/': { LCP: 2410, CLS: 0 } }, { '/': { LCP: 2430, CLS: 0 } }])
		expect(past.note).toBe("Trend chart: main's history from 2 earlier runs (2 unreadable or measured differently, skipped).")
		expect(calls[0].url).toBe(`https://api.github.com/repos/acme/shop/actions/artifacts?name=${NAME}&per_page=100`)
		expect(calls.filter(c => c.url.endsWith('/zip')).map(c => c.url.split('/').at(-2))).toEqual(['5', '4', '3', '1'])
		// The token goes to GitHub only, never to the blob storage it redirects to.
		expect(calls.filter(c => c.url.startsWith('https://blob.test')).every(c => c.auth === null)).toBe(true)
		expect(calls.filter(c => c.url.startsWith('https://api.github.com')).every(c => c.auth === 'Bearer t0ken')).toBe(true)
	})

	it(`downloads at most ${MAX_DOWNLOADS} artifacts and keeps ${MAX_RUNS - 1} past runs`, async () => {
		const list = Array.from({ length: 30 }, (_, i) => artifact(i + 1, 1000 + i, i + 1))
		const zips = Object.fromEntries(list.map(a => [a.id, zip('vitals.json', vitals(2000 + a.id))]))
		const { api, calls } = fakeGitHub(list, zips)
		const past = await loadPastRuns({ api, repo: 'acme/shop', runId: null, setup: SETUP })
		expect(calls.filter(c => c.url.endsWith('/zip'))).toHaveLength(MAX_DOWNLOADS)
		expect(past.runs).toHaveLength(MAX_RUNS - 1)
		expect(past.runs.map(r => r['/']?.LCP)).toEqual(Array.from({ length: 19 }, (_, i) => 2012 + i))
	})

	it('explains a token without actions: read and never throws', async () => {
		const { api } = fakeGitHub([], {}, 403)
		expect(await loadPastRuns({ api, repo: 'acme/shop', runId: 1, setup: SETUP })).toEqual({
			runs: [],
			note: 'Trend chart: none on this run, the token cannot read workflow artifacts (HTTP 403). Add `actions: read` to the job\'s permissions.',
		})
	})

	it('survives no token, no history and a network failure', async () => {
		expect((await loadPastRuns({ api: null, repo: 'acme/shop', runId: 1, setup: SETUP })).note).toContain('no github-token')
		const empty = fakeGitHub([], {})
		expect((await loadPastRuns({ api: empty.api, repo: 'acme/shop', runId: 1, setup: SETUP })).note).toBe(
			'Trend chart: none on this run, no earlier run of this setup has results yet.',
		)
		const down = new GitHubApi('t', 'https://api.github.com', async () => {
			throw new TypeError('fetch failed')
		})
		expect(await loadPastRuns({ api: down, repo: 'acme/shop', runId: 1, setup: SETUP })).toEqual({
			runs: [],
			note: 'Trend chart: none on this run, reading past runs failed: fetch failed.',
		})
	})
})

const metric = (baseMedian: number): MetricResult => ({
	base: [baseMedian],
	head: [baseMedian],
	summary: { baseMedian, headMedian: baseMedian, deltaPct: 0, pValue: 1, shiftLow: 0, shiftHigh: 0, shift: 0, floor: 100, verdict: 'no-change', fromFirstByte: null },
})

const result = (pages: RunResult['pages']): RunResult => ({
	version: 1,
	repo: 'acme/shop',
	prNumber: 1,
	branch: 'x',
	headSha: 'a',
	baseSha: 'b',
	baseUrl: SETUP.baseUrl,
	headUrl: 'https://pr.app.test',
	prodUrl: null,
	ciRunUrl: null,
	config: { pairs: 8, device: 'mobile', latencyMs: 150, downloadKbps: 1638.4, uploadKbps: 750, cpuSlowdown: 4 },
	pages,
	meta: { alpha: 0.05, prodLoads: null, durationMs: null, generatedAt: null },
})

describe('buildHistory', () => {
	it("adds this run's main as the newest point and leaves off runs from before a page or metric existed", () => {
		const past: RunMedians[] = [{ '/': { LCP: 2400 } }, { '/': { LCP: 2410, TBT: 100 } }, { '/': {} }, { '/': { LCP: 2390, TBT: 110 } }]
		const history = buildHistory(
			past,
			result([
				{ path: '/', metrics: { LCP: metric(2405), TBT: metric(105) }, dropped: [], failures: {} },
				{ path: '/new', metrics: { LCP: metric(900) }, dropped: [], failures: {} },
			]),
		)
		expect(history).toEqual({
			'/': { LCP: [2400, 2410, null, 2390, 2405], TBT: [100, null, 110, 105] },
			'/new': { LCP: [900] },
		})
	})
})

describe('saveResult', () => {
	const env = { ACTIONS_RUNTIME_TOKEN: 'x', ACTIONS_RESULTS_URL: 'https://results.test' }

	function fakeArtifacts(fail = false) {
		const calls: string[] = []
		const client: Artifacts = {
			deleteArtifact: async name => {
				calls.push(`delete ${name}`)
				throw new Error('Artifact not found')
			},
			uploadArtifact: async (name, files, root) => {
				calls.push(`upload ${name} ${files.join(',')} ${root}`)
				if (fail) throw new Error('Failed to CreateArtifact: 500')
				return { id: 1, size: 10 }
			},
		}
		return { client, calls }
	}

	it('replaces the artifact of an earlier attempt, then uploads vitals.json under the stable name', async () => {
		const { client, calls } = fakeArtifacts()
		const lines: string[] = []
		expect(await saveResult({ jsonPath: '/tmp/out/vitals.json', name: NAME, env, log: l => lines.push(l) }, client)).toBe(true)
		expect(calls).toEqual([`delete ${NAME}`, `upload ${NAME} /tmp/out/vitals.json /tmp/out`])
		expect(lines).toEqual([`Saved vitals.json as the artifact ${NAME}, for the trend chart on later runs.`])
	})

	it('logs instead of failing when the upload fails or there is no Actions runtime', async () => {
		const lines: string[] = []
		const failing = fakeArtifacts(true)
		expect(await saveResult({ jsonPath: '/o/vitals.json', name: NAME, env, log: l => lines.push(l) }, failing.client)).toBe(false)
		expect(lines.at(-1)).toBe('Could not save vitals.json for the trend chart: Failed to CreateArtifact: 500')
		const local = fakeArtifacts()
		expect(await saveResult({ jsonPath: '/o/vitals.json', name: NAME, env: {}, log: l => lines.push(l) }, local.client)).toBe(false)
		expect(local.calls).toEqual([])
	})
})
