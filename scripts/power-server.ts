// Detection power of the Server row. collect: real servers behind local proxies, one of which adds a known delay on
// head only, sampled in runs exactly like the Action. analyze: the Action's verdict per run and on resampled runs.
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parseArgs } from 'node:util'
import { DEFAULT_ALPHA, DEFAULT_SERVER_SAMPLES, SERVER_WARM_UP } from '../src/config'
import { isRecord } from '../src/github'
import { summariseServer } from '../src/report'
import { joinUrl, roundOrder } from '../src/run'
import { type ServerLoad, serverRequestHeaders, timeRequest } from '../src/server'

interface Condition {
	name: string
	upstream: string
	delayMs: number
}

// Rounds of one run: per condition, one request per round, null when it failed.
type Run = Record<string, ServerLoad[]>

interface Collected {
	base: string
	head: string
	conditions: Condition[]
	samples: number
	startedAt: string
	runs: Record<string, Run[]>
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'host', 'content-length', 'content-encoding'])
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// A slower server is also a larger Server-Timing total.
const addToTotal =(header: string, ms: number): string =>
	header.replace(/(^|,)(\s*total\s*;(?:[^,]*;)?\s*dur\s*=\s*)([\d.]+)/i, (_, start: string, lead: string, dur: string) => `${start}${lead}${Number(dur) + ms}`)

// Forwards each request to the upstream origin and holds the response headers for delayMs.
async function startProxy({ upstream, delayMs }: Condition): Promise<{ origin: string; close: () => Promise<void> }> {
	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const headers = new Headers()
		for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string' && !HOP_BY_HOP.has(name)) headers.set(name, value)
		const upstreamResponse = await fetch(new URL(req.url ?? '/', upstream), { headers, redirect: 'manual' })
		if (delayMs > 0) await sleep(delayMs)
		const out: Record<string, string> = {}
		// fetch decodes the body, so its encoding and length headers no longer apply.
		upstreamResponse.headers.forEach((value, name) => {
			if (!HOP_BY_HOP.has(name)) out[name] = name === 'server-timing' ? addToTotal(value, delayMs) : value
		})
		res.writeHead(upstreamResponse.status, out)
		const reader = upstreamResponse.body?.getReader()
		for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) res.write(chunk.value)
		res.end()
	}
	const server = createServer((req, res) => {
		handle(req, res).catch((err: unknown) => {
			if (!res.headersSent) res.writeHead(502)
			res.end(String(err))
		})
	})
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return { origin: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => server.close(() => resolve())) }
}

async function collect(args: Args): Promise<void> {
	if (!args.base || !args.out) throw new Error('collect needs --base and --out')
	const head = args.head ?? args.base
	const conditions: Condition[] = [
		{ name: 'base', upstream: args.base, delayMs: 0 },
		{ name: 'head', upstream: head, delayMs: 0 },
		...(args.inject ?? []).map(ms => ({ name: `head+${ms}`, upstream: head, delayMs: Number(ms) })),
	]
	const samples = Number(args.samples)
	const proxies = await Promise.all(conditions.map(startProxy))
	const headers = serverRequestHeaders('mobile', {})
	const data: Collected = { base: args.base, head, conditions, samples, startedAt: new Date().toISOString(), runs: {} }
	const request = (i: number, path: string): Promise<ServerLoad> =>
		timeRequest(joinUrl(proxies[i].origin, path), headers).catch((err: unknown) => {
			console.log(`  ${conditions[i].name} ${path} failed: ${String(err).split('\n')[0]}`)
			return null
		})
	const order = conditions.map((_, i) => i)
	try {
		for (const path of args.path ?? ['/']) {
			data.runs[path] = []
			for (let r = 0; r < Number(args.runs); r++) {
				for (let w = 0; w < SERVER_WARM_UP; w++) for (const i of roundOrder(order, w)) await request(i, path)
				const run: Run = Object.fromEntries(conditions.map(c => [c.name, []]))
				for (let round = 0; round < samples; round++) {
					for (const i of roundOrder(order, round)) run[conditions[i].name].push(await request(i, path))
				}
				data.runs[path].push(run)
				const medians = conditions.map(c => `${c.name} ${Math.round(medianOf(run[c.name]))}`).join(', ')
				console.log(`${path} run ${r + 1}: ${medians} ms`)
				await writeFile(args.out, `${JSON.stringify(data)}\n`)
			}
		}
	} finally {
		await Promise.all(proxies.map(p => p.close()))
	}
}

function medianOf(loads: readonly ServerLoad[]): number {
	const v = loads.flatMap(s => (s ? [s.total ?? s.ttfb] : [])).sort((a, b) => a - b)
	if (v.length === 0) return Number.NaN
	const mid = Math.floor(v.length / 2)
	return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

// Mulberry32, so an analysis is reproducible.
function rng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

// Shape only: the file is this script's own collect output.
function isCollected(v: unknown): v is Collected {
	return (
		isRecord(v) &&
		typeof v.base === 'string' &&
		typeof v.head === 'string' &&
		typeof v.samples === 'number' &&
		Array.isArray(v.conditions) &&
		isRecord(v.runs)
	)
}

const verdict = (base: ServerLoad[], head: ServerLoad[]): string =>
	summariseServer({ base, head, failures: { base: [], head: [] } }, DEFAULT_ALPHA)?.summary.verdict ?? 'not compared'

async function analyze(args: Args): Promise<void> {
	const random = rng(Number(args.seed))
	const trials = Number(args.trials)
	for (const file of args.in ?? []) {
		const data: unknown = JSON.parse(await readFile(file, 'utf8'))
		if (!isCollected(data)) throw new Error(`${file} is not a collect output`)
		console.log(`\n${file}: base ${data.base}, head ${data.head}, ${data.samples} requests per side per run`)
		for (const [path, runs] of Object.entries(data.runs)) {
			const compared = data.conditions.filter(c => c.name !== 'base')
			console.log(`  ${path}: ${runs.length} runs`)
			const baseMedians = runs.map(r => Math.round(medianOf(r.base)))
			console.log(`    main median per run: ${Math.min(...baseMedians)} to ${Math.max(...baseMedians)} ms`)
			for (const c of compared) {
				const perRun = runs.map(r => verdict(r.base, r[c.name]))
				const pool = runs.flatMap(r => r.base.map((b, i) => [b, r[c.name][i]] as const))
				let resampled = 0
				const want = c.delayMs === 0 ? 'not no-change' : 'regressed'
				for (let t = 0; t < trials; t++) {
					const picked = Array.from({ length: data.samples }, () => pool[Math.floor(random() * pool.length)])
					const v = verdict(
						picked.map(p => p[0]),
						picked.map(p => p[1]),
					)
					if (c.delayMs === 0 ? v !== 'no-change' : v === 'regressed') resampled++
				}
				const hits = perRun.filter(v => (c.delayMs === 0 ? v !== 'no-change' : v === 'regressed')).length
				const shift = runs.map(r => medianOf(r[c.name]) - medianOf(r.base)).sort((a, b) => a - b)
				console.log(
					`    ${c.name.padEnd(9)} ${want}: ${hits} of ${runs.length} runs, ${((resampled / trials) * 100).toFixed(1)}% of ${trials} resampled runs; median shift ${Math.round(shift[Math.floor(shift.length / 2)])} ms (${perRun.join(' ')})`,
				)
			}
		}
	}
}

interface Args {
	base?: string
	head?: string
	path?: string[]
	inject?: string[]
	runs: string
	samples: string
	out?: string
	in?: string[]
	trials: string
	seed: string
}

const { positionals, values } = parseArgs({
	allowPositionals: true,
	options: {
		base: { type: 'string' },
		head: { type: 'string' },
		path: { type: 'string', multiple: true },
		inject: { type: 'string', multiple: true },
		runs: { type: 'string', default: '20' },
		samples: { type: 'string', default: String(DEFAULT_SERVER_SAMPLES) },
		out: { type: 'string' },
		in: { type: 'string', multiple: true },
		trials: { type: 'string', default: '1000' },
		seed: { type: 'string', default: '1' },
	},
})
const command = positionals[0] === 'collect' ? collect : positionals[0] === 'analyze' ? analyze : null
if (!command) {
	console.error('usage: npm run power -- collect|analyze [flags], see README.md, Detection power')
	process.exit(2)
}
await command(values)
