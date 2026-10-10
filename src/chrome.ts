// Finds a Chrome or Chromium already on the machine, so the action downloads no browser.
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

const COMMANDS = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome']

const KNOWN_PATHS = [
	'/usr/bin/google-chrome-stable',
	'/usr/bin/google-chrome',
	'/opt/google/chrome/chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/snap/bin/chromium',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

export const CHROME_NOT_FOUND = [
	'No Chrome or Chromium found. GitHub-hosted ubuntu-latest, windows-latest and macos-latest runners have Google Chrome',
	'preinstalled. On a self-hosted runner or in a container, add this step before usero-feedback/pr-checks:',
	'  - uses: browser-actions/setup-chrome@v2',
	'    id: chrome',
	'and pass its path with `env: CHROME_BIN: ${{ steps.chrome.outputs.chrome-path }}`.',
].join('\n')

export interface FindChromeEnv {
	env: Record<string, string | undefined>
	isExecutable?: (path: string) => boolean
}

function executable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK)
		return true
	} catch {
		return false
	}
}

// CHROME_BIN wins (and must exist), then commands on PATH, then the usual install locations.
export function findChrome({ env, isExecutable = executable }: FindChromeEnv): string {
	const fromEnv = env.CHROME_BIN?.trim()
	if (fromEnv) {
		if (isExecutable(fromEnv)) return fromEnv
		throw new Error(`CHROME_BIN is set to ${fromEnv}, but no executable is there.`)
	}
	const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
	const extensions = process.platform === 'win32' ? ['.exe', ''] : ['']
	for (const command of COMMANDS) {
		for (const dir of dirs) {
			for (const ext of extensions) {
				const candidate = join(dir, command + ext)
				if (isExecutable(candidate)) return candidate
			}
		}
	}
	const known = KNOWN_PATHS.find(isExecutable)
	if (known) return known
	throw new Error(CHROME_NOT_FOUND)
}
