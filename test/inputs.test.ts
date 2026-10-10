import { describe, expect, it } from 'vitest'
import { DEFAULT_BEACON_PATTERNS } from '../src/config'
import { InputError, parseInputs } from '../src/inputs'

const parse = (values: Record<string, string>) =>
	parseInputs(name => values[name] ?? '')
const minimal = { 'head-url': 'https://pr-7.app.test', 'base-url': 'https://main.app.test' }

describe('parseInputs', () => {
	it('fills every default from two URLs', () => {
		expect(parse(minimal)).toEqual({
			headUrl: 'https://pr-7.app.test',
			baseUrl: 'https://main.app.test',
			prodUrl: null,
			pages: [{ path: '/', interaction: null }],
			rounds: 8,
			device: 'mobile',
			leboostKey: '',
			leboostUrl: 'https://leboost.tech',
			githubToken: '',
			comment: true,
			stubPatterns: [...DEFAULT_BEACON_PATTERNS],
			blockPatterns: [],
			headers: {},
			failOnRegression: false,
			prNumber: null,
		})
	})

	it('reads lists in any mix of lines, spaces and commas, and pairs interactions with their path', () => {
		const inputs = parse({
			...minimal,
			paths: '/\n/docs, /pricing',
			interact: '/docs::button[aria-label="Open menu"]\n# a comment',
			'stub-beacons': '*example.com/track*',
			'block-hosts': 'widgets.example.com',
			headers: 'x-vercel-protection-bypass: abc: def\nx-vercel-set-bypass-cookie: true',
			device: 'desktop',
			rounds: '10',
		})
		expect(inputs.pages).toEqual([
			{ path: '/', interaction: null },
			{ path: '/docs', interaction: 'button[aria-label="Open menu"]' },
			{ path: '/pricing', interaction: null },
		])
		expect(inputs.stubPatterns.at(-1)).toBe('*example.com/track*')
		expect(inputs.blockPatterns).toEqual(['*://widgets.example.com/*', '*://*.widgets.example.com/*'])
		expect(inputs.headers).toEqual({ 'x-vercel-protection-bypass': 'abc: def', 'x-vercel-set-bypass-cookie': 'true' })
		expect(inputs.device).toBe('desktop')
		expect(inputs.rounds).toBe(10)
	})

	it('names the input in every setup mistake', () => {
		const cases: [Record<string, string>, RegExp][] = [
			[{ 'base-url': 'https://main.app.test' }, /head-url is required/],
			[{ 'head-url': 'https://pr.app.test' }, /base-url is required/],
			[{ ...minimal, 'head-url': 'pr-7.app.test' }, /head-url must be an http\(s\) URL/],
			[{ ...minimal, rounds: '2' }, /rounds must be a whole number from 3 to 50/],
			[{ ...minimal, device: 'tablet' }, /device must be mobile or desktop/],
			[{ ...minimal, paths: 'docs' }, /paths must start with \//],
			[{ ...minimal, paths: '/ /' }, /paths lists the same path twice/],
			[{ ...minimal, interact: '/docs::button' }, /interact names \/docs, which is not in paths/],
			[{ ...minimal, comment: 'yes' }, /comment must be true or false/],
			[{ ...minimal, headers: 'no colon here' }, /headers expects one "Name: value" per line/],
		]
		for (const [values, message] of cases) {
			expect(() => parse(values)).toThrow(InputError)
			expect(() => parse(values)).toThrow(message)
		}
	})
})
