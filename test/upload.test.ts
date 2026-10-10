import { describe, expect, it } from 'vitest'
import { buildResult, type PageInput, type RunResult } from '../src/report'
import { uploadResult } from '../src/upload'
import fixture from './fixtures/run.json'

const pages: PageInput[] = fixture.pages
const build = (overrides: { pages?: PageInput[]; repo?: string | null } = {}): RunResult =>
	buildResult({ ...fixture.meta, config: { ...fixture.meta.config, device: 'mobile' }, pages, ...overrides })
const log = () => {}

describe('uploadResult', () => {
	it('skips silently without a key', async () => {
		let called = false
		const fetchImpl: typeof fetch = async () => {
			called = true
			return new Response()
		}
		expect(await uploadResult(build(), { key: '', log, fetchImpl })).toBeNull()
		expect(called).toBe(false)
	})

	it('posts the contract payload and returns the run URL', async () => {
		const requests: { endpoint: string; init: RequestInit | undefined }[] = []
		const fetchImpl: typeof fetch = async (endpoint, init) => {
			requests.push({ endpoint: String(endpoint), init })
			return new Response(JSON.stringify({ runId: 'r1', url: 'https://leboost.tech/runs/r1' }), { status: 201 })
		}
		const url = await uploadResult(build(), { key: 'lb_live_x', baseUrl: 'https://lb.test/', log, fetchImpl })
		expect(url).toBe('https://leboost.tech/runs/r1')
		expect(requests[0].endpoint).toBe('https://lb.test/api/lab-runs')
		expect(new Headers(requests[0].init?.headers).get('X-Leboost-Key')).toBe('lb_live_x')
		const body: unknown = JSON.parse(String(requests[0].init?.body))
		expect(body).toMatchObject({ version: 1, repo: 'acme/shop' })
	})

	it('skips the upload when no page could be compared, or without a repository name', async () => {
		let called = false
		const fetchImpl: typeof fetch = async () => {
			called = true
			return new Response()
		}
		expect(await uploadResult(build({ pages: [pages[2]] }), { key: 'k', log, fetchImpl })).toBeNull()
		expect(await uploadResult(build({ repo: null }), { key: 'k', log, fetchImpl })).toBeNull()
		expect(called).toBe(false)
	})

	it('never throws on HTTP or network errors, and explains a rejected key', async () => {
		const lines: string[] = []
		const warn = (line: string) => lines.push(line)
		expect(await uploadResult(build(), { key: 'k', log: warn, fetchImpl: async () => new Response('{"error":"Missing or invalid X-Leboost-Key"}', { status: 401 }) })).toBeNull()
		expect(await uploadResult(build(), { key: 'k', log: warn, fetchImpl: async () => Promise.reject(new Error('ECONNRESET')) })).toBeNull()
		expect(lines).toHaveLength(2)
		expect(lines[0]).toContain('HTTP 401: leboost did not recognise the key')
		expect(lines[1]).toContain('ECONNRESET')
	})
})
