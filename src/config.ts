// Presets and verdict thresholds. Rationale for each number is in README.md, "Method".

// Server is timed by its own plain requests (src/server.ts), every other metric by the browser page loads.
export const METRICS = ['LCP', 'FCP', 'CLS', 'TBT', 'TTFB', 'Server', 'INP'] as const
export type MetricName = (typeof METRICS)[number]
export const LOAD_METRICS: readonly MetricName[] = METRICS.filter(m => m !== 'Server')

export interface Device {
	viewport: { width: number; height: number }
	deviceScaleFactor: number
	isMobile: boolean
	hasTouch: boolean
	userAgent: string
	network: { latencyMs: number; downloadKbps: number; uploadKbps: number }
	cpuSlowdown: number
}

export type DeviceName = 'mobile' | 'desktop'

// Lighthouse's nominal mobile (Slow 4G, Moto G Power) and desktop profiles, applied as CDP request-level throttling.
export const DEVICES: Record<DeviceName, Device> = {
	mobile: {
		viewport: { width: 412, height: 823 },
		deviceScaleFactor: 1.75,
		isMobile: true,
		hasTouch: true,
		userAgent:
			'Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36',
		network: { latencyMs: 150, downloadKbps: 1638.4, uploadKbps: 750 },
		cpuSlowdown: 4,
	},
	desktop: {
		viewport: { width: 1350, height: 940 },
		deviceScaleFactor: 1,
		isMobile: false,
		hasTouch: false,
		userAgent:
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
		network: { latencyMs: 40, downloadKbps: 10240, uploadKbps: 10240 },
		cpuSlowdown: 1,
	},
}

export interface Floor {
	absFloor: number
	relFloor: number
}

// A verdict needs p < alpha AND a Hodges-Lehmann shift of at least max(absFloor, relFloor x base median),
// the median of what is tested (for LCP and FCP, their time after the first byte).
export const FLOORS: Record<MetricName, Floor> = {
	LCP: { absFloor: 100, relFloor: 0.05 },
	FCP: { absFloor: 100, relFloor: 0.05 },
	TTFB: { absFloor: 100, relFloor: 0.25 },
	Server: { absFloor: 75, relFloor: 0.1 },
	TBT: { absFloor: 50, relFloor: 0.2 },
	INP: { absFloor: 25, relFloor: 0.2 },
	CLS: { absFloor: 0.01, relFloor: 0 },
}

// Tested on paint time minus TTFB, so server time counts once, in the Server row, instead of hiding or faking a paint change.
export const FROM_FIRST_BYTE: readonly MetricName[] = ['LCP', 'FCP']

// Kept in vitals.json with a no-change verdict and left out of the comment: a cold page load's first byte mixes
// connection setup and cold starts into server time. The Server row measures it on warm connections instead.
export const CONTEXT_ONLY: readonly MetricName[] = ['TTFB']

export const DEFAULT_SERVER_SAMPLES = 30
// Requests per side and path on a new connection each, before the warm-up: the likeliest way to reach a cold instance.
export const SERVER_NEW_CONNECTIONS = 10
// Kept-alive connections per side and path. Each opens with one warm-up request; the measured ones rotate over them, since
// one connection stays on one server machine and two machines can differ by tens of ms.
export const SERVER_CONNECTIONS = 5
// Tries per kept-alive connection to reach the edge most new connections reached: from a GitHub runner, connections to one
// site land on edges hundreds of km apart, and every database round trip pays that distance.
export const SERVER_PIN_ATTEMPTS = 4
export const SERVER_TIMEOUT_MS = 30_000
// Without a Server-Timing isolate marker, a time over max(factor x the side's warm median, median + plusMs) is a cold
// start. Up to maxShare of the measured requests are left out of the test; more is how the server behaves, so they stay in.
export const COLD = { factor: 3, plusMs: 300, maxShare: 0.1 }

export const DEFAULT_ALPHA = 0.05
export const DEFAULT_PROD_LOADS = 3
export const SETTLE_MS = 500
export const IDLE_TIMEOUT_MS = 2000
