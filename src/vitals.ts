// One full run: server time per page first, then warm up the previews and interleaved page loads in one headless Chrome.
import { availableParallelism } from 'node:os'
import { chromium } from 'playwright-core'
import { DEFAULT_PROD_LOADS, DEVICES, type DeviceName, IDLE_TIMEOUT_MS, SERVER_CONNECTIONS, SERVER_NEW_CONNECTIONS, SETTLE_MS } from './config'
import { sendHeaders } from './headers'
import { measureLoad } from './measure'
import type { PageInput } from './report'
import { inPool, type Log, type PageSpec, type Side, samplePage, warmUp } from './run'
import { closeConnection, keptAliveConnection, type ServerSamples, sampleServer, serverRequestHeaders, timeGet } from './server'

export interface VitalsRun {
	executablePath: string
	headUrl: string
	baseUrl: string
	prodUrl: string | null
	pages: readonly PageSpec[]
	rounds: number
	serverSamples: number
	device: DeviceName
	// Sent only to the head, base and prod origins.
	headers: Record<string, string>
	// Main and PR loads (and server requests) of a round at the same moment, instead of back to back.
	parallel: boolean
	// Paths measured at once when parallel; 1 keeps one path at a time.
	parallelPages: number
	log: Log
}

const pathsAtOnce = (run: VitalsRun): number => (run.parallel ? run.parallelPages : 1)

// Two loads per path need about two CPUs: on a 2-CPU runner four throttled loads at once stalled for 60 s in testing.
export const browserPathsAtOnce = (requested: number, cpus: number): number => Math.min(requested, Math.max(1, Math.floor(cpus / 2)))

async function measureServer(run: VitalsRun): Promise<Map<string, ServerSamples>> {
	const out = new Map<string, ServerSamples>()
	if (run.serverSamples === 0) return out
	const headers = serverRequestHeaders(run.device, run.headers)
	await inPool(run.pages, pathsAtOnce(run), async page => {
		run.log(
			`${page.path}: server time, ${SERVER_NEW_CONNECTIONS} on new connections, then ${run.serverSamples} measured requests per side over ${SERVER_CONNECTIONS} kept-alive connections`,
		)
		const pools = {
			base: Array.from({ length: SERVER_CONNECTIONS }, keptAliveConnection),
			head: Array.from({ length: SERVER_CONNECTIONS }, keptAliveConnection),
		}
		try {
			const samples = await sampleServer({
				path: page.path,
				baseUrl: run.baseUrl,
				headUrl: run.headUrl,
				samples: run.serverSamples,
				newConnections: SERVER_NEW_CONNECTIONS,
				connections: SERVER_CONNECTIONS,
				request: (url, side, i) => timeGet(url, headers, pools[side][i]),
				newConnection: url => timeGet(url, headers, null),
				reconnect: (side, i) => {
					closeConnection(pools[side][i])
					pools[side][i] = keptAliveConnection()
				},
				log: run.log,
				parallel: run.parallel,
			})
			out.set(page.path, samples)
		} finally {
			for (const connection of [...pools.base, ...pools.head]) closeConnection(connection)
		}
	})
	return out
}

export interface VitalsOutput {
	pages: PageInput[]
	prodLoads: number | null
}

export async function measureVitals(run: VitalsRun): Promise<VitalsOutput> {
	const { log, pages, rounds } = run
	const device = DEVICES[run.device]
	const prodLoads = run.prodUrl ? Math.min(rounds, DEFAULT_PROD_LOADS) : null
	const sides: Side[] = [
		{ name: 'base', url: run.baseUrl },
		{ name: 'head', url: run.headUrl },
	]
	if (run.prodUrl) sides.push({ name: 'prod', url: run.prodUrl, context: true })

	const server = await measureServer(run)
	const browser = await chromium.launch({ headless: true, executablePath: run.executablePath })
	try {
		log(`Chrome ${browser.version()}`)
		await sendHeaders(browser, run.headers, sides.map(s => new URL(s.url).origin))
		const measure = (url: string, page: PageSpec) =>
			measureLoad(browser, url, { device, interaction: page.interaction, settleMs: SETTLE_MS, idleTimeoutMs: IDLE_TIMEOUT_MS })
		// Prod is a warm production deployment; only the previews need waking.
		const cold = sides.filter(s => !s.context)
		log(`Warming up ${cold.map(s => s.name).join(' and ')}`)
		await warmUp({ page: pages[0], sides: cold, measure, log, parallel: run.parallel })
		const atOnce = browserPathsAtOnce(pathsAtOnce(run), availableParallelism())
		if (atOnce < pathsAtOnce(run)) log(`parallel-pages is ${run.parallelPages}, but this runner has ${availableParallelism()} CPUs, so ${atOnce} at a time`)
		const results = await inPool(pages, atOnce, async (page): Promise<PageInput> => {
			log(`${page.path}: ${rounds} rounds of main and PR${prodLoads && page.prod ? `, ${prodLoads} prod loads` : ''}`)
			const { samples, failures } = await samplePage({ page, sides, rounds, contextLoads: prodLoads ?? 0, measure, log, parallel: run.parallel })
			return { path: page.path, loads: samples, failures, server: server.get(page.path) ?? null }
		})
		return { pages: results, prodLoads }
	} finally {
		await browser.close()
	}
}
