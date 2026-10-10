// Optional upload to leboost. Never throws: a failed upload is a warning, not a failed job.
import { createHash, randomUUID } from 'node:crypto'
import type { Env } from './github'
import { type RunResult, toUploadPayload } from './report'
import type { Log } from './run'

export const DEFAULT_LEBOOST_URL = 'https://leboost.tech'
// Waits before the second and third attempt, for network errors and 5xx only.
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 6_000]

export interface UploadOptions {
	key: string
	idempotencyKey: string
	baseUrl?: string
	log: Log
	fetchImpl?: typeof fetch
	retryDelaysMs?: readonly number[]
}

export type UploadOutcome = { status: 'skipped' } | { status: 'uploaded'; url: string | null } | { status: 'failed'; message: string }

// One key per workflow run attempt, commit, step and comparison, so an HTTP retry never stores a second run.
export function uploadIdempotencyKey(env: Env, result: RunResult): string {
	if (!env.GITHUB_RUN_ID) return `local-${randomUUID()}`
	const scope = [
		env.GITHUB_JOB,
		env.GITHUB_ACTION,
		result.config.device,
		result.baseUrl,
		result.headUrl,
		result.prodUrl,
		result.pages.map(page => page.path).join(' '),
	].join('\n')
	const hash = createHash('sha256').update(scope).digest('hex').slice(0, 16)
	return `gh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}-${result.headSha.slice(0, 12)}-${hash}`
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// leboost's error body is { error, issues?: [{ path, message }], docs? }; anything else is shown as raw text.
export function describeRejection(status: number, text: string): string {
	let body: unknown = null
	try {
		body = JSON.parse(text)
	} catch {
		// Not JSON, for example a proxy's HTML error page.
	}
	if (!isRecord(body) || typeof body.error !== 'string') {
		const raw = text.trim().slice(0, 300)
		return `leboost did not store this run (HTTP ${status})${raw ? `: ${raw}` : '.'}`
	}
	const lines = [`leboost did not store this run (HTTP ${status}): ${body.error}`]
	if (Array.isArray(body.issues)) {
		for (const issue of body.issues.slice(0, 10)) {
			if (isRecord(issue) && typeof issue.path === 'string' && typeof issue.message === 'string') {
				lines.push(`  - ${issue.path || '(body)'}: ${issue.message}`)
			}
		}
	}
	if (typeof body.docs === 'string') lines.push(`Docs: ${body.docs}`)
	return lines.join('\n')
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function uploadResult(
	result: RunResult,
	{ key, idempotencyKey, baseUrl, log, fetchImpl = fetch, retryDelaysMs = RETRY_DELAYS_MS }: UploadOptions,
): Promise<UploadOutcome> {
	if (!key) return { status: 'skipped' }
	const payload = toUploadPayload(result)
	if (payload.pages.length === 0) {
		log('Skipped the leboost upload: no page had enough good loads to compare.')
		return { status: 'skipped' }
	}
	if (!payload.repo) {
		log('Skipped the leboost upload: no repository name (GITHUB_REPOSITORY is not set).')
		return { status: 'skipped' }
	}
	const endpoint = `${(baseUrl ?? DEFAULT_LEBOOST_URL).replace(/\/+$/, '')}/api/lab-runs`
	const body = JSON.stringify(payload)
	log(`Uploading to leboost with Idempotency-Key ${idempotencyKey}.`)
	let lastProblem = ''
	for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
		if (attempt > 0) {
			const delay = retryDelaysMs[attempt - 1] ?? 0
			log(`${lastProblem} Retrying in ${Math.round(delay / 1000)} s (attempt ${attempt + 1} of ${retryDelaysMs.length + 1}).`)
			await sleep(delay)
		}
		let res: Response
		try {
			res = await fetchImpl(endpoint, {
				method: 'POST',
				headers: { 'X-Leboost-Key': key, 'Idempotency-Key': idempotencyKey, 'Content-Type': 'application/json' },
				body,
				signal: AbortSignal.timeout(20_000),
			})
		} catch (err) {
			lastProblem = `The leboost upload failed: ${err instanceof Error ? err.message : String(err)}.`
			continue
		}
		const text = await res.text().catch(() => '')
		if (res.ok) {
			let parsed: unknown = null
			try {
				parsed = JSON.parse(text)
			} catch {
				// A 2xx without JSON still stored the run.
			}
			const url = isRecord(parsed) && typeof parsed.url === 'string' ? parsed.url : null
			const replayed = res.headers.get('Idempotent-Replayed') === 'true' ? ' (already stored by an earlier attempt)' : ''
			log(`Uploaded to leboost${replayed}${url ? `: ${url}` : '.'}`)
			return { status: 'uploaded', url }
		}
		const message = describeRejection(res.status, text)
		if (res.status < 500) return { status: 'failed', message }
		lastProblem = message
	}
	return { status: 'failed', message: `${lastProblem} Gave up after ${retryDelaysMs.length + 1} attempts.` }
}
