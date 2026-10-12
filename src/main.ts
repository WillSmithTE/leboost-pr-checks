// The GitHub Action: measure, write the job summary, comment on the PR, set outputs.
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '@actions/core'
import { findChrome } from './chrome'
import { DEFAULT_ALPHA, DEVICES } from './config'
import { contextFromEvent, type Env, findPullRequest, GitHubApi, posInt, readEvent, type RunContext, upsertComment } from './github'
import { artifactName, buildHistory, loadPastRuns } from './history'
import { InputError, type Inputs, parseInputs } from './inputs'
import { buildResult, commentFooter, countVerdicts, renderComment, type RunResult, verdictKey } from './report'
import { firstLine } from './run'
import { saveResult } from './upload'
import { measureVitals } from './vitals'

const log = (line: string): void => core.info(line)

// One comment per device and base URL, so a mobile and a desktop job on the same PR keep separate comments.
export function commentMarker(inputs: Pick<Inputs, 'device' | 'baseUrl'>): string {
	const base = new URL(inputs.baseUrl)
	return `<!-- usero-pr-checks ${inputs.device} ${base.host}${base.pathname.replace(/\/+$/, '')} -->`
}

export function notMeasuredComment(error: string, ctx: Pick<RunContext, 'ciRunUrl'>): string {
	return [
		'### Lab web vitals: not measured on this push',
		'',
		`The check stopped before it could compare this PR with main: ${error}`,
		'',
		`<sub>${commentFooter(false, ctx.ciRunUrl)}</sub>`,
		'',
	].join('\n')
}

async function resolveContext(inputs: Inputs, env: Env): Promise<{ ctx: RunContext; api: GitHubApi | null }> {
	const ctx = contextFromEvent(env, readEvent(env))
	const api = inputs.githubToken ? new GitHubApi(inputs.githubToken, ctx.apiUrl) : null
	if (inputs.prNumber !== null) ctx.prNumber = inputs.prNumber
	else if (ctx.prNumber === null && api && ctx.repo && ctx.headSha) ctx.prNumber = await findPullRequest(api, ctx.repo, ctx.headSha, log)
	return { ctx, api }
}

async function writeFiles(dir: string, result: RunResult | null, comment: string): Promise<string | null> {
	await mkdir(dir, { recursive: true })
	const jsonPath = join(dir, 'vitals.json')
	await Promise.all([
		writeFile(join(dir, 'comment.md'), comment),
		result ? writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`) : Promise.resolve(),
	])
	return result ? jsonPath : null
}

async function postComment(inputs: Inputs, ctx: RunContext, api: GitHubApi | null, body: string, verdict: string): Promise<void> {
	if (!inputs.comment) return log('comment is false, so no PR comment.')
	if (ctx.prNumber === null) return log(`No pull request for this ${ctx.eventName ?? 'run'}, so no PR comment. The results are in the job summary.`)
	if (!api || !ctx.repo) return log('No github-token, so no PR comment. The results are in the job summary.')
	await upsertComment(api, { repo: ctx.repo, prNumber: ctx.prNumber, marker: commentMarker(inputs), verdict, body }, log)
}

export async function run(env: Env = process.env): Promise<void> {
	let inputs: Inputs
	let executablePath: string
	try {
		inputs = parseInputs(name => core.getInput(name))
		executablePath = findChrome({ env })
	} catch (err) {
		// A setup mistake fails the step, so a first install shows what to fix instead of passing silently.
		core.setFailed(err instanceof InputError ? err.message : `Usero PR checks: ${err instanceof Error ? err.message : String(err)}`)
		return
	}
	for (const value of Object.values(inputs.headers)) if (value) core.setSecret(value)

	const { ctx, api } = await resolveContext(inputs, env)
	// Read while the pages load; it never rejects.
	const pastRuns = loadPastRuns({ api, repo: ctx.repo, runId: posInt(Number(env.GITHUB_RUN_ID)), setup: inputs })
	const outDir = join(env.RUNNER_TEMP ?? tmpdir(), 'usero-pr-checks', env.GITHUB_ACTION ?? 'run')
	const started = Date.now()
	let result: RunResult | null = null
	let comment: string
	try {
		const device = DEVICES[inputs.device]
		const measured = await measureVitals({
			executablePath,
			headUrl: inputs.headUrl,
			baseUrl: inputs.baseUrl,
			prodUrl: inputs.prodUrl,
			pages: inputs.pages,
			rounds: inputs.rounds,
			serverSamples: inputs.serverSamples,
			device: inputs.device,
			headers: inputs.headers,
			log,
		})
		result = buildResult({
			repo: ctx.repo,
			prNumber: ctx.prNumber,
			branch: ctx.branch,
			headSha: ctx.headSha,
			baseSha: ctx.baseSha,
			baseUrl: inputs.baseUrl,
			headUrl: inputs.headUrl,
			prodUrl: inputs.prodUrl,
			ciRunUrl: ctx.ciRunUrl,
			config: {
				pairs: inputs.rounds,
				serverRequests: inputs.serverSamples,
				device: inputs.device,
				latencyMs: device.network.latencyMs,
				downloadKbps: device.network.downloadKbps,
				uploadKbps: device.network.uploadKbps,
				cpuSlowdown: device.cpuSlowdown,
			},
			pages: measured.pages,
			prodLoads: measured.prodLoads,
			bundle: inputs.bundle,
			alpha: DEFAULT_ALPHA,
			durationMs: Date.now() - started,
			generatedAt: new Date().toISOString(),
		})
		const { runs, note } = await pastRuns
		log(note)
		comment = renderComment(result, {
			failOnRegression: inputs.failOnRegression,
			history: buildHistory(runs, result),
			chartBaseUrl: inputs.chartBaseUrl,
		})
	} catch (err) {
		core.warning(`Usero PR checks could not finish measuring: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
		comment = notMeasuredComment(firstLine(err), ctx)
	}

	const jsonPath = await writeFiles(outDir, result, comment)
	log(`\n${comment}`)
	await core.summary.addRaw(comment, true).write()
	await postComment(inputs, ctx, api, comment, verdictKey(result))
	if (jsonPath) await saveResult({ jsonPath, name: artifactName(inputs), env, log })

	const { regressions, improvements } = result ? countVerdicts(result) : { regressions: 0, improvements: 0 }
	core.setOutput('regressions', regressions)
	core.setOutput('improvements', improvements)
	core.setOutput('json-path', jsonPath ?? '')
	log(`Finished in ${Math.round((Date.now() - started) / 1000)} s.`)
	if (inputs.failOnRegression && regressions > 0) core.setFailed(`${regressions} web vitals ${regressions === 1 ? 'regression' : 'regressions'} vs main.`)
}
