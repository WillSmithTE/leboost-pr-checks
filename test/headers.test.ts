import { describe, expect, it } from 'vitest'
import { originPattern, withHeaders } from '../src/headers'

describe('originPattern', () => {
	it('matches everything on one origin and escapes Chrome wildcard characters', () => {
		expect(originPattern('https://pr-1.app.test')).toBe('https://pr-1.app.test/*')
		expect(originPattern('http://127.0.0.1:8002')).toBe('http://127.0.0.1:8002/*')
	})
})

describe('withHeaders', () => {
	it('adds the extra headers and replaces any of the same name in any case', () => {
		const request = { Accept: 'text/html', 'X-Vercel-Protection-Bypass': 'old', 'User-Agent': 'ua' }
		expect(withHeaders(request, { 'x-vercel-protection-bypass': 'secret', 'x-vercel-set-bypass-cookie': 'true' })).toEqual([
			{ name: 'Accept', value: 'text/html' },
			{ name: 'User-Agent', value: 'ua' },
			{ name: 'x-vercel-protection-bypass', value: 'secret' },
			{ name: 'x-vercel-set-bypass-cookie', value: 'true' },
		])
	})
})
