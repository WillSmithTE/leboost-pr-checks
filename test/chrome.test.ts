import { describe, expect, it } from 'vitest'
import { CHROME_NOT_FOUND, findChrome } from '../src/chrome'

const only = (...paths: string[]) => (path: string) => paths.includes(path)

describe('findChrome', () => {
	it('prefers CHROME_BIN, then a command on PATH, then a known install location', () => {
		expect(findChrome({ env: { CHROME_BIN: '/opt/chrome', PATH: '/usr/bin' }, isExecutable: only('/opt/chrome', '/usr/bin/google-chrome') })).toBe(
			'/opt/chrome',
		)
		expect(findChrome({ env: { PATH: '/usr/local/bin:/usr/bin' }, isExecutable: only('/usr/bin/chromium', '/usr/local/bin/google-chrome') })).toBe(
			'/usr/local/bin/google-chrome',
		)
		expect(findChrome({ env: { PATH: '' }, isExecutable: only('/opt/google/chrome/chrome') })).toBe('/opt/google/chrome/chrome')
	})

	it('says what to add when nothing is installed, or when CHROME_BIN points nowhere', () => {
		expect(() => findChrome({ env: { PATH: '/usr/bin' }, isExecutable: only() })).toThrow(CHROME_NOT_FOUND)
		expect(CHROME_NOT_FOUND).toContain('browser-actions/setup-chrome')
		expect(() => findChrome({ env: { CHROME_BIN: '/nope' }, isExecutable: only() })).toThrow('CHROME_BIN is set to /nope')
	})
})
