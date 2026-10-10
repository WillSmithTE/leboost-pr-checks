import { describe, expect, it } from 'vitest'
import { compareSamples, hodgesLehmann, mannWhitneyU, median } from '../src/stats'

// Reference values from scipy 1.17 (mannwhitneyu exact/asymptotic) and a brute-force enumeration of every
// rank assignment for the tied cases; the CI references follow R's wilcox.test (qwilcox order statistics).
const SCIPY_DOCS = { x: [20, 11, 17, 12], y: [19, 22, 16, 29, 24] }
const R_DOCS = {
	x: [1.15, 0.88, 0.9, 0.74, 1.21],
	y: [0.8, 0.83, 1.89, 1.04, 1.45, 1.38, 1.91, 1.64, 0.73, 1.46],
}
const SHIFTED = {
	x: [1200, 1180, 1250, 1210, 1190, 1230, 1220],
	y: [1300, 1290, 1350, 1260, 1310, 1330, 1280],
}
const TIES = { x: [0, 0, 0.01, 0.02, 0, 0.01, 0], y: [0.01, 0.02, 0.02, 0.01, 0, 0.03, 0.02] }
// Generated with numpy (seed 7), 45 per side, so the normal approximation path runs.
const LARGE = {
	x: [
		1000, 1015, 986, 955, 977, 950, 1003, 1067, 975, 969, 1024, 1018, 1005, 953, 999, 1035, 933, 977, 905, 936, 908, 988, 937,
		1014, 1008, 991, 874, 973, 998, 1006, 923, 976, 951, 960, 1053, 960, 998, 1044, 971, 994, 1006, 1003, 939, 1004, 1068,
	],
	y: [
		943, 1063, 1026, 988, 1120, 1058, 960, 1024, 1049, 1011, 1054, 1017, 1053, 1092, 986, 1030, 997, 1026, 961, 991, 1010, 1065,
		1077, 954, 980, 1052, 920, 997, 1015, 1083, 1054, 1004, 1002, 1007, 1096, 999, 1005, 1038, 1014, 1010, 964, 1019, 998, 1078,
		1053,
	],
}

describe('median', () => {
	it('handles odd, even, empty and non-finite input', () => {
		expect(median([3, 1, 2])).toBe(2)
		expect(median([4, 1, 3, 2])).toBe(2.5)
		expect(median([])).toBeNull()
		expect(median([Number.NaN, 5])).toBe(5)
	})
})

describe('mannWhitneyU', () => {
	it('matches the scipy docs example (exact, no ties)', () => {
		const r = mannWhitneyU(SCIPY_DOCS.x, SCIPY_DOCS.y)
		expect(r.u).toBe(17)
		expect(r.method).toBe('exact')
		expect(r.pGreater).toBeCloseTo(0.05555555555555555, 12)
		expect(r.pLess).toBeCloseTo(0.9682539682539683, 12)
	})

	it('matches the R wilcox.test docs example (W = 35, one-sided p = 0.1272)', () => {
		const r = mannWhitneyU(R_DOCS.x, R_DOCS.y)
		expect(r.u).toBe(35)
		expect(r.pGreater).toBeCloseTo(0.1272061272061272, 12)
	})

	it('gives the smallest attainable p for a clean 7 vs 7 shift', () => {
		const r = mannWhitneyU(SHIFTED.x, SHIFTED.y)
		expect(r.u).toBe(49)
		expect(r.pGreater).toBeCloseTo(1 / 3432, 12)
		expect(r.pLess).toBe(1)
	})

	it('uses the exact permutation distribution conditional on ties', () => {
		const r = mannWhitneyU(TIES.x, TIES.y)
		expect(r.u).toBe(38.5)
		expect(r.pGreater).toBeCloseTo(0.05011655011655012, 12)
		expect(r.pLess).toBeCloseTo(0.9848484848484849, 12)
	})

	it('returns p = 1 both ways for identical samples', () => {
		const r = mannWhitneyU([5, 5, 5, 5], [5, 5, 5, 5])
		expect(r.pGreater).toBe(1)
		expect(r.pLess).toBe(1)
	})

	it('matches scipy asymptotic (tie and continuity corrected) for large samples', () => {
		const r = mannWhitneyU(LARGE.x, LARGE.y)
		expect(r.method).toBe('normal')
		expect(r.u).toBe(1496.5)
		expect(r.pGreater).toBeCloseTo(4.7671045864493455e-5, 6)
		expect(r.pLess).toBeCloseTo(0.999953894047838, 6)
	})

	it('rejects empty samples', () => {
		expect(() => mannWhitneyU([], [1])).toThrow()
	})
})

describe('hodgesLehmann', () => {
	it('matches R for the scipy docs example', () => {
		expect(hodgesLehmann(SCIPY_DOCS.x, SCIPY_DOCS.y, 0.9)).toEqual({ shift: 7, low: -1, high: 13 })
		expect(hodgesLehmann(SCIPY_DOCS.x, SCIPY_DOCS.y, 0.95)).toEqual({ shift: 7, low: -1, high: 17 })
	})

	it('matches R for the wilcox.test docs example', () => {
		const r = hodgesLehmann(R_DOCS.x, R_DOCS.y, 0.95)
		expect(r.shift).toBeCloseTo(0.305, 9)
		expect(r.low).toBeCloseTo(-0.15, 9)
		expect(r.high).toBeCloseTo(0.76, 9)
	})

	it('brackets a clean shift', () => {
		expect(hodgesLehmann(SHIFTED.x, SHIFTED.y, 0.9)).toEqual({ shift: 90, low: 60, high: 120 })
		expect(hodgesLehmann(SHIFTED.x, SHIFTED.y, 0.95)).toEqual({ shift: 90, low: 60, high: 130 })
	})

	it('handles ties and identical samples', () => {
		const t = hodgesLehmann(TIES.x, TIES.y, 0.9)
		expect(t.shift).toBeCloseTo(0.01, 12)
		expect(t.low).toBeCloseTo(0, 12)
		expect(t.high).toBeCloseTo(0.02, 12)
		expect(hodgesLehmann([5, 5, 5], [5, 5, 5])).toEqual({ shift: 0, low: 0, high: 0 })
	})

	it('uses the normal approximation for large samples', () => {
		const r = hodgesLehmann(LARGE.x, LARGE.y, 0.9)
		expect(r.low).toBeLessThan(r.shift)
		expect(r.high).toBeGreaterThan(r.shift)
		expect(r.low).toBeGreaterThan(0)
	})
})

describe('compareSamples', () => {
	const timing = { alpha: 0.05, absFloor: 50, relFloor: 0.05 }

	it('flags a significant shift past the floor as regressed, and the mirror as improved', () => {
		expect(compareSamples(SHIFTED.x, SHIFTED.y, timing).verdict).toBe('regressed')
		const improved = compareSamples(SHIFTED.y, SHIFTED.x, timing)
		expect(improved.verdict).toBe('improved')
		expect(improved.pValue).toBeCloseTo(1 / 3432, 12)
	})

	it('ignores a significant shift smaller than the practical floor', () => {
		const r = compareSamples(SHIFTED.x, SHIFTED.y, { ...timing, absFloor: 200 })
		expect(r.pValue).toBeLessThan(0.05)
		expect(r.verdict).toBe('no-change')
	})

	it('reports no-change for identical samples and no percent when the base median is 0', () => {
		const r = compareSamples([0, 0, 0, 0, 0], [0, 0, 0, 0, 0], { alpha: 0.05, absFloor: 0.01, relFloor: 0 })
		expect(r).toMatchObject({ verdict: 'no-change', deltaPct: null, pValue: 1, shiftLow: 0, shiftHigh: 0 })
		const tbt = compareSamples([0, 0, 0, 0, 0], [60, 70, 80, 90, 100], { alpha: 0.05, absFloor: 50, relFloor: 0.2 })
		expect(tbt).toMatchObject({ verdict: 'regressed', deltaPct: null, headMedian: 80 })
	})

	it('drops non-finite samples (failed loads) before testing', () => {
		const r = compareSamples([...SHIFTED.x, Number.NaN], [...SHIFTED.y, Number.NaN], timing)
		expect(r.baseMedian).toBe(1210)
		expect(r.headMedian).toBe(1300)
		expect(r.deltaPct).toBeCloseTo((90 / 1210) * 100, 9)
	})
})
