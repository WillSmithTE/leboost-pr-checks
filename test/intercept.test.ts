import { describe, expect, it } from 'vitest'
import beacons from '../beacon-patterns.json'
import { DEFAULT_BEACON_PATTERNS } from '../src/config'
import { classify, hostToPatterns, type InterceptRules, wildcardToRegExp } from '../src/intercept'

const rules = (overrides: Partial<InterceptRules> = {}): InterceptRules => ({
	stub: DEFAULT_BEACON_PATTERNS,
	block: [],
	headers: {},
	headerOrigins: [],
	...overrides,
})

describe('wildcardToRegExp', () => {
	it('follows Chrome: * is any run, ? one character, backslash escapes, everything else literal', () => {
		expect(wildcardToRegExp('*google.com/g/collect*').test('https://www.google.com/g/collect?v=2')).toBe(true)
		expect(wildcardToRegExp('*google.com/g/collect*').test('https://www.google.com/search?q=g/collect')).toBe(false)
		expect(wildcardToRegExp('https://a.test/?').test('https://a.test/x')).toBe(true)
		expect(wildcardToRegExp('https://a.test/\\*').test('https://a.test/*')).toBe(true)
		expect(wildcardToRegExp('https://a.test/\\*').test('https://a.test/x')).toBe(false)
		expect(wildcardToRegExp('*.posthog.com/e/*').test('https://usXposthog.com/e/')).toBe(false)
	})
})

describe('classify', () => {
	it('stubs the data hits of common vendors but lets their scripts load', () => {
		const stubbed = [
			'https://region1.google-analytics.com/g/collect?v=2&tid=G-1',
			'https://www.google.com/g/collect?v=2',
			'https://browser-intake-datadoghq.com/api/v2/rum?ddsource=browser',
			'https://api.segment.io/v1/batch',
			'https://api2.amplitude.com/2/httpapi',
			'https://api-js.mixpanel.com/track/?verbose=1',
			'https://us.i.posthog.com/e/?ip=1',
			'https://rs.fullstory.com/rec/bundle/v2',
			'https://o1.ingest.us.sentry.io/api/2/envelope/',
			'https://www.facebook.com/tr/?id=1&ev=PageView',
			'https://px.ads.linkedin.com/collect?pid=1',
			'https://shop.example.com/cdn-cgi/rum?',
			'https://z.clarity.ms/collect',
			'https://leboost.tech/api/rum',
		]
		for (const url of stubbed) expect(classify(url, rules()), url).toBe('stub')
		const scripts = [
			'https://www.googletagmanager.com/gtag/js?id=G-1',
			'https://www.datadoghq-browser-agent.com/us1/v6/datadog-rum.js',
			'https://cdn.segment.com/analytics.js/v1/key/analytics.min.js',
			'https://us-assets.i.posthog.com/static/array.js',
			'https://edge.fullstory.com/s/fs.js',
			'https://connect.facebook.net/en_US/fbevents.js',
			'https://static.cloudflareinsights.com/beacon.min.js',
			'https://www.clarity.ms/tag/abc',
		]
		for (const url of scripts) expect(classify(url, rules()), url).toBeNull()
	})

	it('blocks opted-in hosts and their subdomains, and stubbing wins over blocking', () => {
		const r = rules({ block: hostToPatterns('widgets.example.com') })
		expect(classify('https://widgets.example.com/embed.js', r)).toBe('block')
		expect(classify('https://cdn.widgets.example.com/a.js', r)).toBe('block')
		expect(classify('https://example.com/a.js', r)).toBeNull()
		expect(classify('https://www.google.com/g/collect', rules({ block: hostToPatterns('google.com') }))).toBe('stub')
	})

	it('adds headers only on the measured origins, and only when there are headers', () => {
		const origins = ['https://pr-1.app.test', 'https://main.app.test']
		const withHeaders = rules({ headers: { 'x-bypass': 's' }, headerOrigins: origins })
		expect(classify('https://pr-1.app.test/assets/a.js', withHeaders)).toBe('headers')
		expect(classify('https://cdn.other.test/a.js', withHeaders)).toBeNull()
		expect(classify('https://pr-1.app.test/', rules({ headerOrigins: origins }))).toBeNull()
	})
})

describe('hostToPatterns', () => {
	it('expands a bare host and keeps a pattern as given', () => {
		expect(hostToPatterns('example.com')).toEqual(['*://example.com/*', '*://*.example.com/*'])
		expect(hostToPatterns('*example.com/widget*')).toEqual(['*example.com/widget*'])
	})
})

describe('beacon-patterns.json', () => {
	it('is a flat list of unique wildcard patterns grouped by vendor', () => {
		const all = Object.values(beacons.patterns).flat()
		expect(all.length).toBeGreaterThan(30)
		expect(new Set(all).size).toBe(all.length)
		for (const p of all) expect(p).toMatch(/^\*/)
	})
})
