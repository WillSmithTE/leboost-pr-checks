// One cold page load in a fresh browser context: emulation, throttling, web-vitals collection.
import type { Browser } from 'playwright-core'
import WEB_VITALS_UMD from '../node_modules/web-vitals/dist/web-vitals.umd.cjs?raw'
import type { Device } from './config'
import type { Metrics } from './run'

const LONG_TASK_MS = 50

interface Collected {
	vitals: Metrics
	longtasks: [number, number][]
	now: number
}

declare global {
	interface Window {
		webVitals: typeof import('web-vitals')
		__leboostVitals: { vitals: Metrics; longtasks: [number, number][] }
	}
}

// Runs in every frame before any page script; only the top frame collects.
function collector() {
	const vitals: Metrics = {}
	const longtasks: [number, number][] = []
	window.__leboostVitals = { vitals, longtasks }
	const opts = { reportAllChanges: true }
	const { onCLS, onFCP, onINP, onLCP, onTTFB } = window.webVitals
	onLCP(m => (vitals.LCP = m.value), opts)
	onFCP(m => (vitals.FCP = m.value), opts)
	onCLS(m => (vitals.CLS = m.value), opts)
	onTTFB(m => (vitals.TTFB = m.value), opts)
	onINP(m => (vitals.INP = m.value), { ...opts, durationThreshold: 16 })
	new PerformanceObserver(list => {
		for (const e of list.getEntries()) longtasks.push([e.startTime, e.duration])
	}).observe({ type: 'longtask', buffered: true })
}

const INIT_SCRIPT = `if (window === window.top) {\n${WEB_VITALS_UMD}\n;(${collector.toString()})()\n}`

// Fires the page-hidden lifecycle so web-vitals finalises LCP, CLS and INP like a real tab switch.
function hidePage() {
	Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
	document.dispatchEvent(new Event('visibilitychange'))
}

// Lighthouse TBT: each long task clipped to [FCP, end] contributes its time over 50 ms.
export function totalBlockingTime(longtasks: readonly [number, number][], fcp: number, end: number): number {
	let total = 0
	for (const [start, duration] of longtasks) {
		const clipped = Math.min(start + duration, end) - Math.max(start, fcp)
		if (clipped > LONG_TASK_MS) total += clipped - LONG_TASK_MS
	}
	return total
}

const kbpsToBytesPerSec = (kbps: number): number => (kbps * 1024) / 8
const round = (metric: string, v: number): number => (metric === 'CLS' ? Math.round(v * 1e4) / 1e4 : Math.round(v * 10) / 10)

export interface MeasureOptions {
	device: Device
	interaction: string | null
	settleMs: number
	idleTimeoutMs: number
}

export async function measureLoad(browser: Browser, url: string, { device, interaction, settleMs, idleTimeoutMs }: MeasureOptions): Promise<Metrics> {
	const context = await browser.newContext({
		viewport: device.viewport,
		deviceScaleFactor: device.deviceScaleFactor,
		isMobile: device.isMobile,
		hasTouch: device.hasTouch,
		userAgent: device.userAgent,
	})
	try {
		const page = await context.newPage()
		await page.addInitScript({ content: INIT_SCRIPT })
		const cdp = await context.newCDPSession(page)
		await cdp.send('Network.enable')
		await cdp.send('Network.emulateNetworkConditions', {
			offline: false,
			latency: device.network.latencyMs,
			downloadThroughput: kbpsToBytesPerSec(device.network.downloadKbps),
			uploadThroughput: kbpsToBytesPerSec(device.network.uploadKbps),
		})
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: device.cpuSlowdown })

		const response = await page.goto(url, { waitUntil: 'load', timeout: 60_000 })
		if (!response) throw new Error('no response')
		if (!response.ok()) throw new Error(`HTTP ${response.status()}`)
		await page.waitForLoadState('networkidle', { timeout: idleTimeoutMs }).catch(() => {})
		await page.waitForTimeout(settleMs)

		if (interaction) {
			await page.locator(interaction).first().click({ timeout: 10_000 })
			await page.waitForTimeout(settleMs)
		}

		await page.evaluate(hidePage)
		await page.waitForTimeout(100)
		const { vitals, longtasks, now } = await page.evaluate((): Collected => ({ ...window.__leboostVitals, now: performance.now() }))
		const metrics: Metrics = { ...vitals }
		if (typeof vitals.FCP === 'number' && Number.isFinite(vitals.FCP)) metrics.TBT = totalBlockingTime(longtasks, vitals.FCP, now)
		if (!interaction) delete metrics.INP
		const out: Metrics = {}
		for (const [k, v] of Object.entries(metrics) as [keyof Metrics, number | null | undefined][]) {
			if (typeof v === 'number') out[k] = round(k, v)
		}
		return out
	} finally {
		await context.close()
	}
}
