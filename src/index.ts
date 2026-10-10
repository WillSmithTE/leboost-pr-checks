import * as core from '@actions/core'
import { run } from './main'

run().catch((err: unknown) => {
	// Never fail a build over a crash in the reporter itself.
	core.warning(`Usero PR checks crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
})
