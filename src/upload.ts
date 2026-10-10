// Optional upload to leboost. Never throws: a failed upload is a warning, not a failed job.
import { type RunResult, toUploadPayload } from './report'
import type { Log } from './run'

export const DEFAULT_LEBOOST_URL = 'https://leboost.tech'

export interface UploadOptions {
	key: string
	baseUrl?: string
	log: Log
	fetchImpl?: typeof fetch
}

const HINTS: Record<number, string> = {
	401: 'leboost did not recognise the key. Copy it again from your site\'s PR checks page in leboost and update the secret.',
	413: 'the run is larger than leboost accepts. Measure fewer paths or rounds.',
}

export async function uploadResult(result: RunResult, { key, baseUrl, log, fetchImpl = fetch }: UploadOptions): Promise<string | null> {
	if (!key) return null
	const payload = toUploadPayload(result)
	if (payload.pages.length === 0) {
		log('Skipped the leboost upload: no page had enough good loads to compare.')
		return null
	}
	if (!payload.repo) {
		log('Skipped the leboost upload: no repository name (GITHUB_REPOSITORY is not set).')
		return null
	}
	const endpoint = `${(baseUrl ?? DEFAULT_LEBOOST_URL).replace(/\/+$/, '')}/api/lab-runs`
	try {
		const res = await fetchImpl(endpoint, {
			method: 'POST',
			headers: { 'X-Leboost-Key': key, 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(20_000),
		})
		if (!res.ok) {
			const body = (await res.text()).slice(0, 500)
			log(`Warning: the leboost upload failed with HTTP ${res.status}${HINTS[res.status] ? `: ${HINTS[res.status]}` : '.'} Response: ${body}`)
			return null
		}
		const body: unknown = await res.json().catch(() => null)
		const url = body !== null && typeof body === 'object' && 'url' in body && typeof body.url === 'string' ? body.url : null
		log(`Uploaded to leboost${url ? `: ${url}` : '.'}`)
		return url
	} catch (err) {
		log(`Warning: the leboost upload failed: ${err instanceof Error ? err.message : String(err)}`)
		return null
	}
}
