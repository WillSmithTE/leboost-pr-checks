import { describe, expect, it } from 'vitest'
import { browserPathsAtOnce } from '../src/vitals'

describe('browserPathsAtOnce', () => {
	it('keeps two loads per two CPUs and never drops below one path', () => {
		expect(browserPathsAtOnce(2, 2)).toBe(1)
		expect(browserPathsAtOnce(2, 4)).toBe(2)
		expect(browserPathsAtOnce(4, 4)).toBe(2)
		expect(browserPathsAtOnce(1, 1)).toBe(1)
		expect(browserPathsAtOnce(3, 16)).toBe(3)
	})
})
