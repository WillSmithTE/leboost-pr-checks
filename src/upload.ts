// Saves vitals.json as a workflow artifact under a stable name, so later runs can draw main's history.
import { basename, dirname } from 'node:path'
import { type ArtifactClient, DefaultArtifactClient } from '@actions/artifact'
import type { Env } from './github'
import type { Log } from './run'

export type Artifacts = Pick<ArtifactClient, 'uploadArtifact' | 'deleteArtifact'>

// Never throws: a run that cannot save its result still reports it.
export async function saveResult(
	{ jsonPath, name, env, log }: { jsonPath: string; name: string; env: Env; log: Log },
	client: Artifacts = new DefaultArtifactClient(),
): Promise<boolean> {
	if (!env.ACTIONS_RUNTIME_TOKEN || !env.ACTIONS_RESULTS_URL) {
		log('Not running in a GitHub Actions job, so vitals.json is not saved for the trend chart.')
		return false
	}
	// A re-run attempt shares the run, and artifact names are unique per run.
	await client.deleteArtifact(name).catch(() => null)
	try {
		await client.uploadArtifact(name, [jsonPath], dirname(jsonPath))
		log(`Saved ${basename(jsonPath)} as the artifact ${name}, for the trend chart on later runs.`)
		return true
	} catch (err) {
		log(`Could not save ${basename(jsonPath)} for the trend chart: ${err instanceof Error ? err.message : String(err)}`)
		return false
	}
}
