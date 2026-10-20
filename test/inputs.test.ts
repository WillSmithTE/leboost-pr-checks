import { describe, expect, it } from 'vitest'
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
			pages: [{ path: '/', interaction: null, prod: true }],
			rounds: 8,
			serverSamples: 30,
			device: 'mobile',
			githubToken: '',
			comment: true,
			headers: {},
			failOnRegression: false,
			parallel: true,
			parallelPages: 1,
			prNumber: null,
			chartBaseUrl: 'https://usero.io/pr-checks/chart.png',
			bundle: { base: null, head: null },
		})
	})

	it('reads the parallel mode and refuses more than 4 paths at once', () => {
		expect(parse({ ...minimal, parallel: 'false', 'parallel-pages': '3' })).toMatchObject({ parallel: false, parallelPages: 3 })
		expect(() => parse({ ...minimal, 'parallel-pages': '6' })).toThrow('parallel-pages must be a whole number from 1 to 4')
	})

	it('reads bundle sizes in bytes, and an empty one as not given', () => {
		expect(parse({ ...minimal, 'base-bundle-bytes': '33810000', 'head-bundle-bytes': ' ' }).bundle).toEqual({ base: 33810000, head: null })
		expect(() => parse({ ...minimal, 'head-bundle-bytes': '7.2 MB' })).toThrow('head-bundle-bytes must be a whole number')
	})

	it('takes a chart server for testing and refuses one that is not a URL', () => {
		expect(parse({ ...minimal, 'chart-base-url': 'http://localhost:5230/pr-checks/chart.png' }).chartBaseUrl).toBe(
			'http://localhost:5230/pr-checks/chart.png',
		)
		expect(() => parse({ ...minimal, 'chart-base-url': 'charts' })).toThrow('chart-base-url must be an http(s) URL')
	})

	it('reads lists in any mix of lines, spaces and commas, and pairs interactions with their path', () => {
		const inputs = parse({
			...minimal,
			paths: '/\n/docs, /pricing',
			interact: '/docs::button[aria-label="Open menu"]\n# a comment',
			headers: 'x-vercel-protection-bypass: abc: def\nx-vercel-set-bypass-cookie: true',
			device: 'desktop',
			rounds: '10',
		})
		expect(inputs.pages).toEqual([
			{ path: '/', interaction: null, prod: true },
			{ path: '/docs', interaction: 'button[aria-label="Open menu"]', prod: true },
			{ path: '/pricing', interaction: null, prod: true },
		])
		expect(inputs.headers).toEqual({ 'x-vercel-protection-bypass': 'abc: def', 'x-vercel-set-bypass-cookie': 'true' })
		expect(inputs.device).toBe('desktop')
		expect(inputs.rounds).toBe(10)
	})

	it('loads prod only on the paths in prod-paths, and on every path when it is empty', () => {
		const pages = (values: Record<string, string>) => parse({ ...minimal, 'prod-url': 'https://app.test', paths: '/ /b/fieldnote /docs', ...values }).pages
		expect(pages({ 'prod-paths': '/\n/docs' }).map(p => [p.path, p.prod])).toEqual([
			['/', true],
			['/b/fieldnote', false],
			['/docs', true],
		])
		expect(pages({ 'prod-paths': ' ' }).every(p => p.prod)).toBe(true)
		expect(pages({}).every(p => p.prod)).toBe(true)
	})

	it('takes a server time request count, and 0 to turn it off', () => {
		expect(parse({ ...minimal, 'server-samples': '60' }).serverSamples).toBe(60)
		expect(parse({ ...minimal, 'server-samples': '0' }).serverSamples).toBe(0)
	})

	it('names the input in every setup mistake', () => {
		const cases: [Record<string, string>, RegExp][] = [
			[{ 'base-url': 'https://main.app.test' }, /head-url is required/],
			[{ 'head-url': 'https://pr.app.test' }, /base-url is required/],
			[{ ...minimal, 'head-url': 'pr-7.app.test' }, /head-url must be an http\(s\) URL/],
			[{ ...minimal, rounds: '2' }, /rounds must be a whole number from 3 to 50/],
			[{ ...minimal, 'server-samples': '5' }, /server-samples must be 0 \(off\) or a whole number from 10 to 200/],
			[{ ...minimal, 'server-samples': 'lots' }, /server-samples must be 0/],
			[{ ...minimal, device: 'tablet' }, /device must be mobile or desktop/],
			[{ ...minimal, paths: 'docs' }, /paths must start with \//],
			[{ ...minimal, paths: '/ /' }, /paths lists the same path twice/],
			[{ ...minimal, interact: '/docs::button' }, /interact names \/docs, which is not in paths/],
			[{ ...minimal, paths: '/ /docs', 'prod-paths': '/ /pricing' }, /prod-paths names \/pricing, which is not in paths/],
			[{ ...minimal, 'prod-paths': 'docs' }, /prod-paths names docs, which is not in paths/],
			[{ ...minimal, comment: 'yes' }, /comment must be true or false/],
			[{ ...minimal, headers: 'no colon here' }, /headers expects one "Name: value" per line/],
		]
		for (const [values, message] of cases) {
			expect(() => parse(values)).toThrow(InputError)
			expect(() => parse(values)).toThrow(message)
		}
	})
})
