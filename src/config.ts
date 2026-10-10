// Presets and verdict thresholds. Rationale for each number is in README.md, "Method".
import beacons from '../beacon-patterns.json'

export const METRICS = ['LCP', 'FCP', 'CLS', 'TBT', 'TTFB', 'INP'] as const
export type MetricName = (typeof METRICS)[number]

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
	TBT: { absFloor: 50, relFloor: 0.2 },
	INP: { absFloor: 25, relFloor: 0.2 },
	CLS: { absFloor: 0.01, relFloor: 0 },
}

// Tested on paint time minus TTFB, so a slow preview server shows in TTFB instead of hiding or faking a paint change.
export const FROM_FIRST_BYTE: readonly MetricName[] = ['LCP', 'FCP']

// Shown and tested, but the verdict is always no-change: two previews' server speed varies independently of the code.
export const CONTEXT_ONLY: readonly MetricName[] = ['TTFB']

export const DEFAULT_ALPHA = 0.05
export const DEFAULT_PROD_LOADS = 3
export const SETTLE_MS = 500
export const IDLE_TIMEOUT_MS = 2000

// Analytics and RUM data hits, answered with an empty 204. The list lives in beacon-patterns.json so other runners can share it.
export const DEFAULT_BEACON_PATTERNS: readonly string[] = Object.values(beacons.patterns).flat()
