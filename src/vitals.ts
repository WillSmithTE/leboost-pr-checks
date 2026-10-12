// One full run: server time per page first, then warm up the previews and interleaved page loads in one headless Chrome.
import { chromium } from 'playwright-core'
import { DEFAULT_PROD_LOADS, DEVICES, type DeviceName, IDLE_TIMEOUT_MS, SERVER_WARM_UP, SETTLE_MS } from './config'
import { sendHeaders } from './headers'
import { measureLoad } from './measure'
import type { PageInput } from './report'
import { type Log, type PageSpec, type Side, samplePage, warmUp } from './run'
import { type ServerSamples, sampleServer, timeRequest } from './server'

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
	log: Log
}

const DOCUMENT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

async function measureServer(run: VitalsRun): Promise<Map<string, ServerSamples>> {
	const out = new Map<string, ServerSamples>()
	if (run.serverSamples === 0) return out
	// The browser's user agent, so the server answers as it does for the page loads.
	const headers: Record<string, string> = { 'user-agent': DEVICES[run.device].userAgent, accept: DOCUMENT_ACCEPT }
	for (const [name, value] of Object.entries(run.headers)) headers[name.toLowerCase()] = value
	for (const page of run.pages) {
		run.log(`${page.path}: server time, ${SERVER_WARM_UP} warm-up and ${run.serverSamples} requests per side`)
		const samples = await sampleServer({
			path: page.path,
			baseUrl: run.baseUrl,
			headUrl: run.headUrl,
			samples: run.serverSamples,
			warmUp: SERVER_WARM_UP,
			request: url => timeRequest(url, headers),
			log: run.log,
		})
		out.set(page.path, samples)
	}
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
	const results: PageInput[] = []
	try {
		log(`Chrome ${browser.version()}`)
		await sendHeaders(browser, run.headers, sides.map(s => new URL(s.url).origin))
		const measure = (url: string, page: PageSpec) =>
			measureLoad(browser, url, { device, interaction: page.interaction, settleMs: SETTLE_MS, idleTimeoutMs: IDLE_TIMEOUT_MS })
		// Prod is a warm production deployment; only the previews need waking.
		const cold = sides.filter(s => !s.context)
		log(`Warming up ${cold.map(s => s.name).join(' and ')}`)
		await warmUp({ page: pages[0], sides: cold, measure, log })
		for (const page of pages) {
			log(`${page.path}: ${rounds} rounds of main and PR${prodLoads ? `, ${prodLoads} prod loads` : ''}`)
			const { samples, failures } = await samplePage({ page, sides, rounds, contextLoads: prodLoads ?? 0, measure, log })
			results.push({ path: page.path, loads: samples, failures, server: server.get(page.path) ?? null })
		}
		return { pages: results, prodLoads }
	} finally {
		await browser.close()
	}
}
