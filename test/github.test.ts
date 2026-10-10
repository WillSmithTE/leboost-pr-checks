import { describe, expect, it } from 'vitest'
import { contextFromEvent, findPullRequest, GitHubApi, upsertComment } from '../src/github'
import { commentMarker, notMeasuredComment } from '../src/main'

const env = {
	GITHUB_REPOSITORY: 'acme/shop',
	GITHUB_RUN_ID: '99',
	GITHUB_SERVER_URL: 'https://github.com',
	GITHUB_SHA: 'aaaaaaa1111111',
	GITHUB_REF_NAME: 'main',
	GITHUB_HEAD_REF: '',
}

describe('contextFromEvent', () => {
	it('takes the PR, head and base from a pull_request event', () => {
		const event = { pull_request: { number: 12, head: { sha: 'bbbbbbb', ref: 'feat/x' }, base: { sha: 'ccccccc' } } }
		expect(contextFromEvent({ ...env, GITHUB_EVENT_NAME: 'pull_request' }, event)).toMatchObject({
			repo: 'acme/shop',
			prNumber: 12,
			headSha: 'bbbbbbb',
			baseSha: 'ccccccc',
			branch: 'feat/x',
			ciRunUrl: 'https://github.com/acme/shop/actions/runs/99',
		})
	})

	it('takes the commit from deployment_status and status events, leaving the PR to a lookup', () => {
		const deployment = { deployment: { sha: 'ddddddd', ref: 'feat/y' }, deployment_status: { state: 'success' } }
		expect(contextFromEvent({ ...env, GITHUB_EVENT_NAME: 'deployment_status' }, deployment)).toMatchObject({
			prNumber: null,
			headSha: 'ddddddd',
			branch: 'feat/y',
		})
		const status = { sha: 'eeeeeee', state: 'success', branches: [{ name: 'feat/z' }] }
		expect(contextFromEvent({ ...env, GITHUB_EVENT_NAME: 'status' }, status)).toMatchObject({ prNumber: null, headSha: 'eeeeeee', branch: 'feat/z' })
	})

	it('reads workflow_run and falls back to the run commit for anything else', () => {
		const run = { workflow_run: { head_sha: 'fffffff', head_branch: 'feat/w', pull_requests: [{ number: 3 }] } }
		expect(contextFromEvent({ ...env, GITHUB_EVENT_NAME: 'workflow_run' }, run)).toMatchObject({ prNumber: 3, headSha: 'fffffff' })
		expect(contextFromEvent({ ...env, GITHUB_EVENT_NAME: 'push' }, {})).toMatchObject({ prNumber: null, headSha: 'aaaaaaa1111111', branch: 'main' })
	})
})

interface Call {
	method: string
	url: string
	body: unknown
}

function fakeApi(routes: (call: Call) => { status: number; data: unknown }) {
	const calls: Call[] = []
	const fetchImpl: typeof fetch = async (input, init) => {
		const call: Call = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null }
		calls.push(call)
		const { status, data } = routes(call)
		return new Response(JSON.stringify(data), { status })
	}
	return { api: new GitHubApi('t', 'https://api.github.com', fetchImpl), calls }
}

const marker = '<!-- leboost-pr-checks mobile main.app.test -->'

describe('upsertComment', () => {
	const lines: string[] = []
	const log = (line: string) => lines.push(line)

	it('creates the comment when the PR has none of ours', async () => {
		const { api, calls } = fakeApi(c => (c.method === 'GET' ? { status: 200, data: [{ id: 1, body: 'hi' }] } : { status: 201, data: {} }))
		expect(await upsertComment(api, { repo: 'acme/shop', prNumber: 5, marker, body: '### Lab' }, log)).toBe('created')
		expect(calls[1]).toMatchObject({ method: 'POST', url: 'https://api.github.com/repos/acme/shop/issues/5/comments', body: { body: `${marker}\n### Lab` } })
	})

	it('edits the earlier comment with the same marker, looking past the first page', async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'other' }))
		const { api, calls } = fakeApi(c => {
			if (c.method === 'PATCH') return { status: 200, data: {} }
			const page = new URL(c.url).searchParams.get('page')
			return page === '1' ? { status: 200, data: page1 } : { status: 200, data: [{ id: 777, body: `${marker}\nold` }] }
		})
		expect(await upsertComment(api, { repo: 'acme/shop', prNumber: 5, marker, body: 'new' }, log)).toBe('updated')
		expect(calls.at(-1)).toMatchObject({ method: 'PATCH', url: 'https://api.github.com/repos/acme/shop/issues/comments/777' })
	})

	it('skips with a clear line when the token is read-only, as on a fork PR', async () => {
		const { api } = fakeApi(c =>
			c.method === 'GET' ? { status: 200, data: [] } : { status: 403, data: { message: 'Resource not accessible by integration' } },
		)
		expect(await upsertComment(api, { repo: 'acme/shop', prNumber: 5, marker, body: 'x' }, log)).toBe('no-permission')
		expect(lines.at(-1)).toContain('Skipped the PR comment: the token cannot write pull request comments (HTTP 403)')
		expect(lines.at(-1)).toContain('job summary')
	})
})

describe('findPullRequest', () => {
	it('picks the open PR whose head is the commit', async () => {
		const { api } = fakeApi(() => ({
			status: 200,
			data: [
				{ number: 1, state: 'closed', head: { sha: 'abc1234' } },
				{ number: 2, state: 'open', head: { sha: 'other00' } },
				{ number: 3, state: 'open', head: { sha: 'abc1234' } },
			],
		}))
		expect(await findPullRequest(api, 'acme/shop', 'abc1234', () => {})).toBe(3)
	})
})

describe('comment helpers', () => {
	it('keys the marker on device and base URL so separate setups keep separate comments', () => {
		expect(commentMarker({ device: 'mobile', baseUrl: 'https://main.app.test/' })).toBe('<!-- leboost-pr-checks mobile main.app.test -->')
		expect(commentMarker({ device: 'desktop', baseUrl: 'https://x.test/app/' })).toBe('<!-- leboost-pr-checks desktop x.test/app -->')
	})

	it('explains a run that could not measure without blaming the PR', () => {
		const md = notMeasuredComment('browserType.launch: Target closed', { ciRunUrl: 'https://github.com/acme/shop/actions/runs/1' })
		expect(md).toContain('### Lab web vitals: not measured on this push')
		expect(md).toContain('[CI run](https://github.com/acme/shop/actions/runs/1)')
		expect(md).toContain('never blocks the PR')
	})
})
