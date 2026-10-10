// One full run: warm up the previews, then interleaved rounds per page, in a single headless Chrome.
import { chromium } from 'playwright-core'
import { DEFAULT_PROD_LOADS, DEVICES, type DeviceName, IDLE_TIMEOUT_MS, SETTLE_MS } from './config'
import { sendHeaders } from './headers'
import { measureLoad } from './measure'
import type { PageInput } from './report'
import { type Log, type PageSpec, type Side, samplePage, warmUp } from './run'

export interface VitalsRun {
	executablePath: string
	headUrl: string
	baseUrl: string
	prodUrl: string | null
	pages: readonly PageSpec[]
	rounds: number
	device: DeviceName
	// Sent only to the head, base and prod origins.
	headers: Record<string, string>
	log: Log
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
			results.push({ path: page.path, loads: samples, failures })
		}
		return { pages: results, prodLoads }
	} finally {
		await browser.close()
	}
}
