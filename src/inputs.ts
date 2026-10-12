// Action inputs, parsed and validated. Every error message names the input so a first setup is easy to fix.
import { CHART_BASE_URL } from './chart'
import { DEFAULT_SERVER_SAMPLES, DEVICES, type DeviceName } from './config'
import type { BundleSizes } from './report'
import type { PageSpec } from './run'

export class InputError extends Error {}

export interface Inputs {
	headUrl: string
	baseUrl: string
	prodUrl: string | null
	pages: PageSpec[]
	rounds: number
	// Server time requests per side and path; 0 turns server time off.
	serverSamples: number
	device: DeviceName
	githubToken: string
	comment: boolean
	headers: Record<string, string>
	failOnRegression: boolean
	prNumber: number | null
	chartBaseUrl: string
	bundle: BundleSizes
}

export type GetInput = (name: string) => string

const MAX_ROUNDS = 50
const MIN_SERVER_SAMPLES = 10
const MAX_SERVER_SAMPLES = 200

// Paths never contain spaces, so any mix of newlines, spaces and commas separates them.
const words = (raw: string): string[] => raw.split(/[\s,]+/).filter(Boolean)
const lines = (raw: string): string[] =>
	raw
		.split('\n')
		.map(l => l.trim())
		.filter(l => l.length > 0 && !l.startsWith('#'))

function url(name: string, raw: string): string {
	try {
		const u = new URL(raw)
		if (u.protocol === 'http:' || u.protocol === 'https:') return raw
	} catch {}
	throw new InputError(`${name} must be an http(s) URL, got "${raw}".`)
}

function bool(name: string, raw: string, fallback: boolean): boolean {
	const v = raw.trim().toLowerCase()
	if (v === '') return fallback
	if (v === 'true') return true
	if (v === 'false') return false
	throw new InputError(`${name} must be true or false, got "${raw}".`)
}

function int(name: string, raw: string, { min, max }: { min: number; max: number }): number {
	const n = Number(raw.trim())
	if (!Number.isInteger(n) || n < min || n > max) throw new InputError(`${name} must be a whole number from ${min} to ${max}, got "${raw}".`)
	return n
}

function serverSamples(raw: string): number {
	const n = Number(raw.trim())
	if (n === 0) return 0
	if (!Number.isInteger(n) || n < MIN_SERVER_SAMPLES || n > MAX_SERVER_SAMPLES) {
		throw new InputError(`server-samples must be 0 (off) or a whole number from ${MIN_SERVER_SAMPLES} to ${MAX_SERVER_SAMPLES}, got "${raw}".`)
	}
	return n
}

// Empty is "not given": a CI step that could not read the size passes nothing.
function bytes(name: string, raw: string): number | null {
	if (raw === '') return null
	return int(name, raw, { min: 0, max: Number.MAX_SAFE_INTEGER })
}

function parseHeaders(raw: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const line of lines(raw)) {
		const at = line.indexOf(':')
		const name = line.slice(0, at).trim()
		if (at < 1 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
			throw new InputError('headers expects one "Name: value" per line.')
		}
		out[name] = line.slice(at + 1).trim()
	}
	return out
}

function parsePages(pathsRaw: string, interactRaw: string, prodPathsRaw: string): PageSpec[] {
	const paths = words(pathsRaw)
	if (paths.length === 0) paths.push('/')
	for (const path of paths) {
		if (!path.startsWith('/')) throw new InputError(`paths must start with /, got "${path}".`)
	}
	if (new Set(paths).size !== paths.length) throw new InputError('paths lists the same path twice.')
	// Empty means every path, so prod-url alone keeps loading prod everywhere.
	const prodPaths = words(prodPathsRaw)
	for (const path of prodPaths) {
		if (!paths.includes(path)) throw new InputError(`prod-paths names ${path}, which is not in paths. List only paths from paths.`)
	}
	const interactions = new Map<string, string>()
	for (const line of lines(interactRaw)) {
		const at = line.indexOf('::')
		if (at < 1) throw new InputError(`interact expects "PATH::SELECTOR" per line, got "${line}".`)
		const path = line.slice(0, at).trim()
		if (!paths.includes(path)) throw new InputError(`interact names ${path}, which is not in paths.`)
		interactions.set(path, line.slice(at + 2).trim())
	}
	return paths.map(path => ({
		path,
		interaction: interactions.get(path) ?? null,
		prod: prodPaths.length === 0 || prodPaths.includes(path),
	}))
}

export function parseInputs(get: GetInput): Inputs {
	// Actions passes an unset input (or an unset secret) as an empty string, so empty means the default.
	const input = (name: string, fallback = ''): string => {
		const v = get(name).trim()
		return v === '' ? fallback : v
	}
	const headRaw = input('head-url')
	const baseRaw = input('base-url')
	if (!headRaw) throw new InputError('head-url is required: the URL of this pull request\'s preview deployment.')
	if (!baseRaw) throw new InputError('base-url is required: the URL to compare against, usually your main branch preview.')
	const prodRaw = input('prod-url')
	const deviceRaw = input('device', 'mobile')
	if (!(deviceRaw in DEVICES)) throw new InputError(`device must be mobile or desktop, got "${deviceRaw}".`)
	const prRaw = input('pr-number')
	return {
		headUrl: url('head-url', headRaw),
		baseUrl: url('base-url', baseRaw),
		prodUrl: prodRaw ? url('prod-url', prodRaw) : null,
		pages: parsePages(input('paths'), get('interact'), input('prod-paths')),
		rounds: int('rounds', input('rounds', '8'), { min: 3, max: MAX_ROUNDS }),
		serverSamples: serverSamples(input('server-samples', String(DEFAULT_SERVER_SAMPLES))),
		device: deviceRaw === 'desktop' ? 'desktop' : 'mobile',
		githubToken: input('github-token'),
		comment: bool('comment', input('comment'), true),
		headers: parseHeaders(get('headers')),
		failOnRegression: bool('fail-on-regression', input('fail-on-regression'), false),
		prNumber: prRaw ? int('pr-number', prRaw, { min: 1, max: Number.MAX_SAFE_INTEGER }) : null,
		chartBaseUrl: url('chart-base-url', input('chart-base-url', CHART_BASE_URL)),
		bundle: { base: bytes('base-bundle-bytes', input('base-bundle-bytes')), head: bytes('head-bundle-bytes', input('head-bundle-bytes')) },
	}
}
