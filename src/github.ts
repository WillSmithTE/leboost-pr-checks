// The pull request this run belongs to, and the one comment the action keeps up to date on it.
import { readFileSync } from 'node:fs'
import type { Log } from './run'

export type Env = Record<string, string | undefined>
type Json = Record<string, unknown>

export const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
export const at = (v: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((o, k) => (isRecord(o) ? o[k] : undefined), v)
export const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
export const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)

export interface RunContext {
	repo: string | null
	eventName: string | null
	prNumber: number | null
	headSha: string
	baseSha: string | null
	branch: string | null
	ciRunUrl: string | null
	apiUrl: string
}

export function readEvent(env: Env): unknown {
	const path = env.GITHUB_EVENT_PATH
	if (!path) return null
	try {
		const event: unknown = JSON.parse(readFileSync(path, 'utf8'))
		return event
	} catch {
		return null
	}
}

// What the event itself says; deployment_status and status events carry a commit but no PR, found later by SHA.
export function contextFromEvent(env: Env, event: unknown): RunContext {
	const eventName = env.GITHUB_EVENT_NAME ?? null
	const repo = env.GITHUB_REPOSITORY ?? null
	const server = env.GITHUB_SERVER_URL ?? 'https://github.com'
	const ciRunUrl = repo && env.GITHUB_RUN_ID ? `${server}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null
	const pr = at(event, 'pull_request')
	const workflowRun = at(event, 'workflow_run')
	const fallbackBranch = str(env.GITHUB_HEAD_REF) ?? str(env.GITHUB_REF_NAME)
	const base = { repo, eventName, ciRunUrl, apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com' }

	if (isRecord(pr)) {
		return {
			...base,
			prNumber: posInt(pr.number),
			headSha: str(at(pr, 'head', 'sha')) ?? env.GITHUB_SHA ?? '',
			baseSha: str(at(pr, 'base', 'sha')),
			branch: str(at(pr, 'head', 'ref')) ?? fallbackBranch,
		}
	}
	if (eventName === 'deployment_status') {
		return {
			...base,
			prNumber: null,
			headSha: str(at(event, 'deployment', 'sha')) ?? env.GITHUB_SHA ?? '',
			baseSha: null,
			branch: str(at(event, 'deployment', 'ref')),
		}
	}
	if (eventName === 'status') {
		const branches = at(event, 'branches')
		return {
			...base,
			prNumber: null,
			headSha: str(at(event, 'sha')) ?? env.GITHUB_SHA ?? '',
			baseSha: null,
			branch: Array.isArray(branches) ? str(at(branches[0], 'name')) : null,
		}
	}
	if (isRecord(workflowRun)) {
		const prs = workflowRun.pull_requests
		return {
			...base,
			prNumber: Array.isArray(prs) ? posInt(at(prs[0], 'number')) : null,
			headSha: str(workflowRun.head_sha) ?? env.GITHUB_SHA ?? '',
			baseSha: null,
			branch: str(workflowRun.head_branch),
		}
	}
	return { ...base, prNumber: null, headSha: env.GITHUB_SHA ?? '', baseSha: null, branch: fallbackBranch }
}

export class GitHubApi {
	constructor(
		private readonly token: string,
		private readonly apiUrl: string,
		private readonly fetchImpl: typeof fetch = fetch,
	) {}

	async request(method: string, path: string, body?: Json): Promise<{ status: number; data: unknown }> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'User-Agent': 'usero-pr-checks',
		}
		if (body) headers['Content-Type'] = 'application/json'
		const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
			method,
			headers,
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(20_000),
		})
		const data: unknown = await res.json().catch(() => null)
		return { status: res.status, data }
	}

	// A binary download such as an artifact zip. GitHub redirects to blob storage, which must not get the token.
	async download(path: string, maxBytes: number): Promise<{ status: number; bytes: Uint8Array | null }> {
		const first = await this.fetchImpl(`${this.apiUrl}${path}`, {
			headers: { Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'usero-pr-checks' },
			redirect: 'manual',
			signal: AbortSignal.timeout(20_000),
		})
		const location = first.headers.get('location')
		const redirected = first.status >= 300 && first.status < 400 && location !== null
		if (redirected) await first.body?.cancel()
		const res = redirected ? await this.fetchImpl(location, { signal: AbortSignal.timeout(20_000) }) : first
		if (res.status !== 200 || Number(res.headers.get('content-length') ?? 0) > maxBytes) {
			await res.body?.cancel()
			return { status: res.status === 200 ? 413 : res.status, bytes: null }
		}
		const bytes = new Uint8Array(await res.arrayBuffer())
		return bytes.length > maxBytes ? { status: 413, bytes: null } : { status: 200, bytes }
	}
}

// The open PR whose head is this commit, for events that only carry a SHA.
export async function findPullRequest(api: GitHubApi, repo: string, sha: string, log: Log): Promise<number | null> {
	try {
		const { status, data } = await api.request('GET', `/repos/${repo}/commits/${sha}/pulls`)
		if (status !== 200 || !Array.isArray(data)) {
			log(`Could not look up the pull request for ${sha.slice(0, 7)} (HTTP ${status}).`)
			return null
		}
		const open = data.filter(pr => at(pr, 'state') === 'open')
		const match = open.find(pr => at(pr, 'head', 'sha') === sha) ?? open[0]
		return posInt(at(match, 'number'))
	} catch (err) {
		log(`Could not look up the pull request: ${err instanceof Error ? err.message : String(err)}`)
		return null
	}
}

// 3000 comments; a busier PR gets a fresh comment instead of an endless scan.
const MAX_COMMENT_PAGES = 30

export type CommentOutcome = 'created' | 'updated' | 'replaced' | 'no-permission' | 'failed'

const VERDICT_LINE = /^<!-- verdict: ([^>]*) -->$/m
export const verdictLine = (verdict: string): string => `<!-- verdict: ${verdict} -->`

// GitHub emails only on a new comment. Same verdict as last time: edit the comment in place, quietly. A new verdict
// (clean to regression, back, or a different set): post a fresh one so it reaches the inbox, and delete the old one.
// A comment from before verdicts were recorded is edited.
export async function upsertComment(
	api: GitHubApi,
	{ repo, prNumber, marker, verdict, body }: { repo: string; prNumber: number; marker: string; verdict: string; body: string },
	log: Log,
): Promise<CommentOutcome> {
	const full = `${marker}\n${verdictLine(verdict)}\n${body}`
	try {
		let existing: { id: number; verdict: string | null } | null = null
		for (let page = 1; existing === null && page <= MAX_COMMENT_PAGES; page++) {
			const { status, data } = await api.request('GET', `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`)
			if (status !== 200 || !Array.isArray(data)) return reportFailure(status, 'read', log)
			const hit = data.find(c => str(at(c, 'body'))?.startsWith(marker))
			const id = posInt(at(hit, 'id'))
			if (id !== null) existing = { id, verdict: str(at(hit, 'body'))?.match(VERDICT_LINE)?.[1] ?? null }
			if (data.length < 100) break
		}
		if (existing !== null && (existing.verdict === null || existing.verdict === verdict)) {
			const { status } = await api.request('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body: full })
			if (status !== 200) return reportFailure(status, 'write', log)
			log(`Updated the results comment on PR #${prNumber}; the verdict is unchanged, so no notification.`)
			return 'updated'
		}
		const { status } = await api.request('POST', `/repos/${repo}/issues/${prNumber}/comments`, { body: full })
		if (status !== 200 && status !== 201) return reportFailure(status, 'write', log)
		if (existing === null) {
			log(`Posted the results comment on PR #${prNumber}.`)
			return 'created'
		}
		const removed = await api.request('DELETE', `/repos/${repo}/issues/comments/${existing.id}`)
		log(
			`The verdict changed (${existing.verdict} to ${verdict}), so posted a new results comment on PR #${prNumber}` +
				(removed.status === 204 ? ' and deleted the old one.' : ` and could not delete the old one (HTTP ${removed.status}).`),
		)
		return 'replaced'
	} catch (err) {
		log(`Could not comment on PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}. The results are in the job summary.`)
		return 'failed'
	}
}

function reportFailure(status: number, what: 'read' | 'write', log: Log): CommentOutcome {
	if (status === 401 || status === 403 || status === 404) {
		log(
			`Skipped the PR comment: the token cannot ${what} pull request comments (HTTP ${status}). Pull requests from forks ` +
				'get a read-only token, and so does a workflow without `permissions: pull-requests: write`. The results are in the job summary.',
		)
		return 'no-permission'
	}
	log(`Could not comment on the PR (HTTP ${status}). The results are in the job summary.`)
	return 'failed'
}
