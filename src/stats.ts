// Two-sample statistics for lab vitals: medians, one-sided Mann-Whitney U, Hodges-Lehmann shift.
// Sample y is the candidate (head), x the reference (base). Positive shifts mean y is larger.
import type { Floor } from './config'

// Above this combined size the exact permutation distribution gives way to the normal approximation.
const EXACT_MAX_N = 80

export type Verdict = 'regressed' | 'improved' | 'no-change'

const finite = (values: readonly (number | null | undefined)[]): number[] =>
	values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

export function median(values: readonly (number | null | undefined)[]): number | null {
	const sorted = finite(values).sort((a, b) => a - b)
	if (sorted.length === 0) return null
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// Average ranks (1-based) for ties, doubled so they stay integers.
function doubledMidranks(values: readonly number[]): { ranks: number[]; tieCubes: number } {
	const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
	const ranks = new Array<number>(values.length).fill(0)
	let tieCubes = 0
	for (let i = 0; i < order.length; ) {
		let j = i
		while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++
		for (let k = i; k <= j; k++) ranks[order[k][1]] = i + j + 2
		const t = j - i + 1
		tieCubes += t * t * t - t
		i = j + 1
	}
	return { ranks, tieCubes }
}

// Exact null distribution of the doubled rank sum of an m-subset, conditional on the observed ranks.
function rankSumDistribution(ranks: readonly number[], m: number): { counts: Float64Array; total: number } {
	const maxSum = ranks.reduce((a, b) => a + b, 0)
	let dp = Array.from({ length: m + 1 }, () => new Float64Array(maxSum + 1))
	dp[0][0] = 1
	for (const r of ranks) {
		const next = dp.map(row => row.slice())
		for (let k = 0; k < m; k++) {
			const row = dp[k]
			for (let s = 0; s + r <= maxSum; s++) if (row[s]) next[k + 1][s + r] += row[s]
		}
		dp = next
	}
	const counts = dp[m]
	const total = counts.reduce((a, b) => a + b, 0)
	return { counts, total }
}

function normalCdf(z: number): number {
	return 0.5 * erfc(-z / Math.SQRT2)
}

// Numerical Recipes erfcc (Chebyshev fit), fractional error below 1.2e-7.
function erfc(x: number): number {
	const z = Math.abs(x)
	const t = 1 / (1 + 0.5 * z)
	const r =
		t *
		Math.exp(
			-z * z -
				1.26551223 +
				t *
					(1.00002368 +
						t *
							(0.37409196 +
								t *
									(0.09678418 +
										t *
											(-0.18628806 +
												t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
		)
	return x >= 0 ? r : 2 - r
}

export interface MannWhitney {
	u: number
	pGreater: number
	pLess: number
	method: 'exact' | 'normal'
}

// U statistic of y (pairs where y > x, ties count half) and both one-sided p-values.
export function mannWhitneyU(x: readonly number[], y: readonly number[]): MannWhitney {
	const n1 = x.length
	const n2 = y.length
	if (n1 === 0 || n2 === 0) throw new Error('mannWhitneyU needs two non-empty samples')
	const { ranks, tieCubes } = doubledMidranks([...x, ...y])
	const ySum2 = ranks.slice(n1).reduce((a, b) => a + b, 0)
	const u = ySum2 / 2 - (n2 * (n2 + 1)) / 2
	const n = n1 + n2

	if (n <= EXACT_MAX_N) {
		const { counts, total } = rankSumDistribution(ranks, n2)
		let ge = 0
		let le = 0
		for (let s = 0; s < counts.length; s++) {
			if (!counts[s]) continue
			if (s >= ySum2) ge += counts[s]
			if (s <= ySum2) le += counts[s]
		}
		return { u, pGreater: ge / total, pLess: le / total, method: 'exact' }
	}

	const mu = (n1 * n2) / 2
	const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tieCubes / (n * (n - 1))))
	if (sigma === 0) return { u, pGreater: 1, pLess: 1, method: 'normal' }
	return {
		u,
		pGreater: 1 - normalCdf((u - mu - 0.5) / sigma),
		pLess: normalCdf((u - mu + 0.5) / sigma),
		method: 'normal',
	}
}

// Null distribution of U for the given ranks, as cumulative probabilities indexed by U.
function uCdf(x: readonly number[], y: readonly number[]): { u: number; p: number }[] | null {
	const n2 = y.length
	if (x.length + n2 > EXACT_MAX_N) return null
	const { ranks } = doubledMidranks([...x, ...y])
	const { counts, total } = rankSumDistribution(ranks, n2)
	const offset = n2 * (n2 + 1)
	const cdf: { u: number; p: number }[] = []
	let acc = 0
	for (let s = 0; s < counts.length; s++) {
		acc += counts[s]
		if (s >= offset) cdf.push({ u: (s - offset) / 2, p: acc / total })
	}
	return cdf
}

// Hodges-Lehmann shift (median of y_j - x_i) with a distribution-free confidence interval
// (the order-statistic method R's wilcox.test uses).
export function hodgesLehmann(
	x: readonly number[],
	y: readonly number[],
	confidence = 0.9,
): { shift: number; low: number; high: number } {
	const diffs: number[] = []
	for (const yi of y) for (const xi of x) diffs.push(yi - xi)
	diffs.sort((a, b) => a - b)
	const mn = diffs.length
	const shift = median(diffs) ?? 0
	const tail = (1 - confidence) / 2

	let k: number
	const cdf = uCdf(x, y)
	if (cdf) {
		// Smallest U whose cumulative probability reaches the tail (R's qwilcox), at least 1.
		const hit = cdf.find(c => c.p >= tail - 1e-12)
		k = Math.max(1, Math.floor(hit?.u ?? 0))
	} else {
		const n = x.length + y.length
		const sigma = Math.sqrt((mn * (n + 1)) / 12)
		k = Math.max(1, Math.floor(mn / 2 - inverseNormal(1 - tail) * sigma))
	}
	return { shift, low: diffs[k - 1], high: diffs[mn - k] }
}

// Acklam's inverse normal CDF, good to ~1e-9.
function inverseNormal(p: number): number {
	const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
	const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
	const c = [
		-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783,
	]
	const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
	const lo = 0.02425
	if (p < lo) {
		const q = Math.sqrt(-2 * Math.log(p))
		return (
			(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
			((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
		)
	}
	if (p > 1 - lo) return -inverseNormal(1 - p)
	const q = p - 0.5
	const r = q * q
	return (
		((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
		(((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
	)
}

export interface Comparison {
	baseMedian: number
	headMedian: number
	deltaPct: number | null
	pValue: number
	shiftLow: number
	shiftHigh: number
	shift: number
	floor: number
	verdict: Verdict
}

// Verdict for a lower-is-better metric: significant in one direction AND past the practical floor.
// Callers guarantee at least one finite value per side.
export function compareSamples(
	base: readonly (number | null | undefined)[],
	head: readonly (number | null | undefined)[],
	{ alpha, absFloor, relFloor }: Floor & { alpha: number },
): Comparison {
	const x = finite(base)
	const y = finite(head)
	const baseMedian = median(x) ?? 0
	const headMedian = median(y) ?? 0
	const { pGreater, pLess } = mannWhitneyU(x, y)
	const { shift, low, high } = hodgesLehmann(x, y, 1 - 2 * alpha)
	const floor = Math.max(absFloor, relFloor * Math.abs(baseMedian))
	let verdict: Verdict = 'no-change'
	if (pGreater < alpha && shift >= floor) verdict = 'regressed'
	else if (pLess < alpha && -shift >= floor) verdict = 'improved'
	return {
		baseMedian,
		headMedian,
		// A percent of a zero base means nothing (common for CLS and TBT).
		deltaPct: baseMedian === 0 ? null : ((headMedian - baseMedian) / baseMedian) * 100,
		pValue: shift >= 0 ? pGreater : pLess,
		shiftLow: low,
		shiftHigh: high,
		shift,
		floor,
		verdict,
	}
}
