import { describe, expect, it } from 'vitest'
import { uploadSummaryNote } from '../src/main'
import { buildResult, type PageInput, type RunResult } from '../src/report'
import { describeRejection, uploadIdempotencyKey, uploadResult } from '../src/upload'
import fixture from './fixtures/run.json'

const pages: PageInput[] = fixture.pages
const build = (overrides: { pages?: PageInput[]; repo?: string | null } = {}): RunResult =>
	buildResult({ ...fixture.meta, config: { ...fixture.meta.config, device: 'mobile' }, pages, ...overrides })
const log = () => {}
const base = { key: 'lb_live_x', idempotencyKey: 'gh-1-1-abc', log, retryDelaysMs: [0, 0] }

type Call = { endpoint: string; init: RequestInit | undefined }
function fakeFetch(responses: (Response | Error)[]): { fetchImpl: typeof fetch; calls: Call[] } {
	const calls: Call[] = []
	const fetchImpl: typeof fetch = async (endpoint, init) => {
		calls.push({ endpoint: String(endpoint), init })
		const next = responses[Math.min(calls.length - 1, responses.length - 1)]
		if (next instanceof Error) throw next
		return next.clone()
	}
	return { fetchImpl, calls }
}

const created = (headers: Record<string, string> = {}) =>
	new Response(JSON.stringify({ runId: 'r1', url: 'https://leboost.tech/runs/r1' }), { status: 201, headers })

describe('uploadResult', () => {
	it('skips silently without a key', async () => {
		const { fetchImpl, calls } = fakeFetch([created()])
		expect(await uploadResult(build(), { ...base, key: '', fetchImpl })).toEqual({ status: 'skipped' })
		expect(calls).toHaveLength(0)
	})

	it('posts the contract payload with the idempotency key and returns the run URL', async () => {
		const { fetchImpl, calls } = fakeFetch([created()])
		const outcome = await uploadResult(build(), { ...base, baseUrl: 'https://lb.test/', fetchImpl })
		expect(outcome).toEqual({ status: 'uploaded', url: 'https://leboost.tech/runs/r1' })
		expect(calls[0].endpoint).toBe('https://lb.test/api/lab-runs')
		const headers = new Headers(calls[0].init?.headers)
		expect(headers.get('X-Leboost-Key')).toBe('lb_live_x')
		expect(headers.get('Idempotency-Key')).toBe('gh-1-1-abc')
		const body: unknown = JSON.parse(String(calls[0].init?.body))
		expect(body).toMatchObject({ version: 1, repo: 'acme/shop' })
	})

	it('skips the upload when no page could be compared, or without a repository name', async () => {
		const { fetchImpl, calls } = fakeFetch([created()])
		expect(await uploadResult(build({ pages: [pages[2]] }), { ...base, fetchImpl })).toEqual({ status: 'skipped' })
		expect(await uploadResult(build({ repo: null }), { ...base, fetchImpl })).toEqual({ status: 'skipped' })
		expect(calls).toHaveLength(0)
	})

	it('retries network errors and 5xx with the same key, then succeeds', async () => {
		const lines: string[] = []
		const { fetchImpl, calls } = fakeFetch([new Error('ECONNRESET'), new Response('{"error":"boom"}', { status: 502 }), created({ 'Idempotent-Replayed': 'true' })])
		const outcome = await uploadResult(build(), { ...base, log: line => lines.push(line), fetchImpl })
		expect(outcome).toEqual({ status: 'uploaded', url: 'https://leboost.tech/runs/r1' })
		expect(calls.map(c => new Headers(c.init?.headers).get('Idempotency-Key'))).toEqual(['gh-1-1-abc', 'gh-1-1-abc', 'gh-1-1-abc'])
		expect(calls.map(c => c.init?.body)).toEqual(Array(3).fill(calls[0].init?.body))
		expect(lines.some(l => l.includes('ECONNRESET') && l.includes('attempt 2 of 3'))).toBe(true)
		expect(lines.at(-1)).toContain('already stored by an earlier attempt')
	})

	it('gives up after three attempts and never throws', async () => {
		const { fetchImpl, calls } = fakeFetch([new Error('ECONNRESET')])
		const outcome = await uploadResult(build(), { ...base, fetchImpl })
		expect(calls).toHaveLength(3)
		expect(outcome).toEqual({ status: 'failed', message: 'The leboost upload failed: ECONNRESET. Gave up after 3 attempts.' })
	})

	it('does not retry a 4xx and passes leboost\'s message through verbatim', async () => {
		const rejection = {
			error: 'The X-Leboost-Key header is not a valid leboost site key. Copy it from your PR checks page.',
			docs: 'https://github.com/WillSmithTE/leboost-pr-checks#upload-api',
		}
		for (const status of [400, 401, 413, 429]) {
			const { fetchImpl, calls } = fakeFetch([new Response(JSON.stringify(rejection), { status })])
			const outcome = await uploadResult(build(), { ...base, fetchImpl })
			expect(calls).toHaveLength(1)
			expect(outcome).toEqual({
				status: 'failed',
				message: `leboost did not store this run (HTTP ${status}): ${rejection.error}\nDocs: ${rejection.docs}`,
			})
		}
	})
})

describe('describeRejection', () => {
	it('lists contract issues with their paths', () => {
		const body = JSON.stringify({
			error: 'Invalid payload: config.device: Required (and 1 more issue)',
			issues: [
				{ path: 'config.device', message: 'Required' },
				{ path: '', message: 'Expected object' },
			],
			docs: 'https://docs.test',
		})
		expect(describeRejection(400, body)).toBe(
			[
				'leboost did not store this run (HTTP 400): Invalid payload: config.device: Required (and 1 more issue)',
				'  - config.device: Required',
				'  - (body): Expected object',
				'Docs: https://docs.test',
			].join('\n'),
		)
	})

	it('shows a non-JSON body as raw text', () => {
		expect(describeRejection(502, '<html>Bad gateway</html>')).toBe('leboost did not store this run (HTTP 502): <html>Bad gateway</html>')
		expect(describeRejection(404, '')).toBe('leboost did not store this run (HTTP 404).')
	})

	it('puts the message in the job summary note as is', () => {
		expect(uploadSummaryNote('line one\nline two')).toContain('```text\nline one\nline two\n```')
	})
})

describe('uploadIdempotencyKey', () => {
	const env = { GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'web-vitals', GITHUB_ACTION: '__WillSmithTE_leboost-pr-checks' }

	it('is stable for one run attempt and step, and changes with the attempt, job or comparison', () => {
		const result = build()
		const key = uploadIdempotencyKey(env, result)
		expect(key).toMatch(new RegExp(`^gh-123456-2-${result.headSha.slice(0, 12)}-[0-9a-f]{16}$`))
		expect(uploadIdempotencyKey({ ...env }, build())).toBe(key)
		expect(uploadIdempotencyKey({ ...env, GITHUB_RUN_ATTEMPT: '3' }, result)).not.toBe(key)
		expect(uploadIdempotencyKey({ ...env, GITHUB_JOB: 'web-vitals-desktop' }, result)).not.toBe(key)
		const desktop = buildResult({ ...fixture.meta, config: { ...fixture.meta.config, device: 'desktop' }, pages })
		expect(uploadIdempotencyKey(env, desktop)).not.toBe(key)
		expect(key.length).toBeLessThanOrEqual(255)
	})

	it('is random outside GitHub Actions', () => {
		const a = uploadIdempotencyKey({}, build())
		expect(a).toMatch(/^local-[0-9a-f-]{36}$/)
		expect(uploadIdempotencyKey({}, build())).not.toBe(a)
	})
})
