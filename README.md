# leboost PR checks

A GitHub Action that measures lab web vitals (LCP, FCP, CLS, TBT, TTFB, optionally INP) on a pull request's preview and
on your main branch's preview, back to back in the same job. It runs a significance test on the difference and comments on
the PR only about changes larger than run-to-run noise. It never fails your build unless you ask it to.

## Quick start

You need a preview URL for each PR and one for main. Add this job after the job that deploys the PR preview:

```yaml
  web-vitals:
    needs: deploy-preview
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: WillSmithTE/leboost-pr-checks@v1
        with:
          head-url: https://pr-${{ github.event.number }}.my-app.example.com
          base-url: https://main.my-app.example.com
          paths: / /pricing
```

That is the whole setup. The first run posts a comment on the PR, and every later push updates the same comment. The full
result is also in the job summary.

Recipes for common hosts are below: [Cloudflare](#cloudflare-workers-and-pages), [Vercel](#vercel),
[Netlify](#netlify) and [GitHub Pages](#github-pages).

## What it reports

- The comment's title is the answer: "no significant change vs main", "1 regression vs main", "2 regressions, 1 improvement
  vs main".
- Each regression or improvement gets one line with the metric, the page and the size of the change.
- When nothing moved, one line says what a run of this size can still miss, for example "an LCP change under 110 ms".
- Failed loads, and pages or metrics without enough good loads, are listed rather than left out.
- A table with every metric per page, folded away unless something regressed.

The [demo repository](https://github.com/WillSmithTE/leboost-pr-checks-demo/pulls?q=is%3Apr) has a PR with a deliberate
slow hero image and a PR that changes nothing, with the comments this action posted on each.

## Inputs

| Input                | Default               | What it does                                                                                                                                  |
| -------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `head-url`           | required              | The PR's preview URL.                                                                                                                         |
| `base-url`           | required              | What to compare against, usually main's preview. The comment calls it "main". Any path on the URL is kept, so `https://x.dev/app` works.     |
| `prod-url`           |                       | Your production URL. Its medians are shown in the table for reference and never change the result.                                           |
| `paths`              | `/`                   | Pages to measure. One per line, or separated by spaces or commas.                                                                            |
| `rounds`             | `8`                   | Rounds per page, 3 to 50. Each round loads main and the PR once, in alternating order.                                                       |
| `device`             | `mobile`              | `mobile` (Lighthouse's Slow 4G and 4x CPU profile) or `desktop`.                                                                             |
| `interact`           |                       | INP measurement: one `PATH::SELECTOR` per line, clicked after load. Without it INP is not reported.                                          |
| `stub-beacons`       |                       | Extra URL patterns to answer with an empty 204, added to the built-in list. See [Your analytics stay clean](#your-analytics-stay-clean).     |
| `block-hosts`        |                       | Hosts or URL patterns to block entirely, scripts included. Off by default.                                                                   |
| `headers`            |                       | Extra request headers, one `Name: value` per line, sent only to the head, base and prod sites.                                               |
| `leboost-key`        |                       | Your leboost site key, to keep every run's history. See [Keep a history in leboost](#keep-a-history-in-leboost).                              |
| `leboost-url`        | `https://leboost.tech` | The leboost endpoint.                                                                                                                         |
| `github-token`       | `${{ github.token }}` | Finds the PR and posts the comment.                                                                                                           |
| `comment`            | `true`                | Post or update the PR comment. The job summary is written either way.                                                                         |
| `pr-number`          | from the event        | The PR to comment on. Found from the event or the commit; set it for `workflow_dispatch` runs.                                               |
| `fail-on-regression` | `false`               | Fail the job when anything regressed.                                                                                                         |

| Output         | What it holds                                                                    |
| -------------- | -------------------------------------------------------------------------------- |
| `regressions`  | Number of significant regressions vs main.                                       |
| `improvements` | Number of significant improvements vs main.                                      |
| `run-url`      | The run's page in leboost, empty without a key.                                  |
| `json-path`    | `vitals.json` with every raw sample and the summary. Upload it to keep it:       |

```yaml
      - uses: WillSmithTE/leboost-pr-checks@v1
        id: vitals
        with: { head-url: ..., base-url: ... }
      - uses: actions/upload-artifact@v4
        with: { name: web-vitals, path: '${{ steps.vitals.outputs.json-path }}' }
```

The job fails only on a setup mistake (a missing or invalid input, or no Chrome on the runner), so a first install shows
what to fix. A preview that is down or a load that times out is reported in the comment and the job still passes.

## Recipes

Every recipe measures the PR preview against a preview of main built the same way. Comparing against production would mix
in its warm caches, real data and different third-party tags. Pass production as `prod-url` if you want it in the table.

### Cloudflare Workers and Pages

**Workers with a preview per PR.** If your deploy job uploads a preview Worker or a preview alias per PR, its URL is
predictable from the PR number. Run the check after that job:

```yaml
on: pull_request

jobs:
  deploy-preview:
    # your existing job, for example: npx wrangler versions upload --preview-alias pr-${{ github.event.number }}
  web-vitals:
    needs: deploy-preview
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    concurrency:
      group: web-vitals-${{ github.event.number }}
      cancel-in-progress: true
    steps:
      - uses: WillSmithTE/leboost-pr-checks@v1
        with:
          head-url: https://pr-${{ github.event.number }}-my-worker.my-account.workers.dev
          base-url: https://main-my-worker.my-account.workers.dev
          prod-url: https://example.com
          paths: / /docs
          leboost-key: ${{ secrets.LEBOOST_KEY }}
```

Cloudflare does not send GitHub deployment events, so the check has to run in the same workflow, after the deploy.

**Pages deployed from Actions.** `cloudflare/wrangler-action` returns the deployment URL as an output:

```yaml
      - id: deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          command: pages deploy dist --project-name=my-site --branch=${{ github.head_ref }}
      - uses: WillSmithTE/leboost-pr-checks@v1
        with:
          head-url: ${{ steps.deploy.outputs.deployment-url }}
          base-url: https://main.my-site.pages.dev
```

`https://main.my-site.pages.dev` is the alias of the latest deploy from the `main` branch. If main is your production
branch, use `https://my-site.pages.dev` as `base-url` instead.

### Vercel

Vercel reports each deployment to GitHub, so the check can start when a preview is ready:

```yaml
on: deployment_status

jobs:
  web-vitals:
    if: github.event.deployment_status.state == 'success' && github.event.deployment_status.environment != 'Production'
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: WillSmithTE/leboost-pr-checks@v1
        with:
          head-url: ${{ github.event.deployment_status.environment_url }}
          base-url: https://my-app-git-main-my-team.vercel.app
          headers: |
            x-vercel-protection-bypass: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
            x-vercel-set-bypass-cookie: true
```

- `deployment_status` events carry a commit but no PR number, so the action finds the open PR for that commit itself.
- `base-url` is the branch URL of `main` (`<project>-git-main-<team>.vercel.app`). Your production URL works too, with the
  caveats above.
- With Deployment Protection on, create a secret under Project Settings, Deployment Protection, Protection Bypass for
  Automation, and store it as a repository secret. The headers are sent only to the preview and base URLs, never to third
  parties.
- On a monorepo, Vercel names the environment per project (for example `Preview – web`), so filter on that if several
  projects deploy from one repo.

### Netlify

Netlify does not send GitHub deployment events, but its commit status for a deploy preview links to the preview:

```yaml
on: status

jobs:
  web-vitals:
    if: >-
      github.event.state == 'success' &&
      startsWith(github.event.context, 'netlify/') && endsWith(github.event.context, '/deploy-preview')
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: WillSmithTE/leboost-pr-checks@v1
        with:
          head-url: ${{ github.event.target_url }}
          base-url: https://main--my-site.netlify.app
```

`https://main--my-site.netlify.app` is the branch deploy of `main`; turn on branch deploys for `main` in Netlify, or use your
production URL. The `status` event runs the workflow file from your default branch, so merge it before testing on a PR. If
`target_url` points to the Netlify dashboard rather than the preview on your account, use
`https://deploy-preview-${{ github.event.number }}--my-site.netlify.app` from a `pull_request` workflow instead and add a
step that waits until the preview serves the PR's commit.

### GitHub Pages

The [demo repository](https://github.com/WillSmithTE/leboost-pr-checks-demo) publishes main at the site root and each PR
under `/pr-preview/pr-<number>/` on the `gh-pages` branch, then runs the check in the same workflow. Its
[workflow](https://github.com/WillSmithTE/leboost-pr-checks-demo/blob/main/.github/workflows/pr.yml) is a complete example.

## Your analytics stay clean

Every page loads its analytics, RUM and session replay scripts as usual, so a heavy or slow tag shows up in the numbers like
any other regression. The data those scripts send never leaves the runner's browser: requests to the data endpoints of
common vendors are answered with an empty `204 No Content` (with CORS headers, so the script sees a success and does not
retry). This covers Google Analytics 4 and Google Ads, Datadog RUM and Session Replay, Segment, Amplitude, Mixpanel, PostHog,
Heap, Hotjar, FullStory, Microsoft Clarity, LogRocket, Sentry, New Relic Browser, Plausible, Cloudflare Web Analytics,
Vercel Analytics, leboost RUM, Usero session replay, and the Meta, LinkedIn, X, Reddit, TikTok and Microsoft Ads pixels. The full list is in
[beacon-patterns.json](beacon-patterns.json), grouped by vendor and in Chrome's URL wildcard syntax, so other tools can
reuse it.

- Requests from iframes and web workers are covered too.
- Add your own endpoints with `stub-beacons`, for example a first-party proxy such as `*example.com/ingest/*` or a
  server-side Google Tag Manager domain.
- A stubbed hit answers instantly, so the time a real beacon would spend on the network is missing. Beacons rarely sit on
  the critical path, but this makes the numbers slightly optimistic for pages that wait on one.
- Data sent over a WebSocket (some Hotjar setups) is not intercepted. Add that host to `block-hosts` if it matters.
- `block-hosts` blocks hosts entirely, scripts included. Use it for something you never want in the measurement, such as a
  chat widget that loads differently on previews.

## Keep a history in leboost

Without a key the action comments and writes the job summary, and nothing leaves your CI. With a
[leboost](https://leboost.tech) site key every run is also stored in leboost's PR checks, where you can open any run with all
its samples and follow a page's LCP or TBT across PRs.

1. Add your site at [leboost.tech](https://leboost.tech) and open its **PR checks** page. The page shows the site key with a
   Copy button. It is the same key leboost's RUM snippet uses.
2. Save it as a repository secret named `LEBOOST_KEY` (Settings, Secrets and variables, Actions).
3. Pass it to the action: `leboost-key: ${{ secrets.LEBOOST_KEY }}`.

The comment then links to the run in leboost. A failed upload is a warning in the log and never fails the job.

## Permissions and pull requests from forks

- The comment needs `pull-requests: write`. Repositories created after February 2023 default to a read-only token, so add
  the `permissions` block from the quick start.
- A pull request from a fork gets a read-only token and no secrets. The action still measures (if a preview exists for
  the fork), writes the result to the job summary, skips the comment with one line in the log saying why, and skips the
  leboost upload. It never fails the job for this.
- Do not switch to `pull_request_target` to get a write token for forks unless you understand the risk: it runs with secrets
  on untrusted code.

## Run time

A load takes 2 to 10 seconds at the mobile profile, depending on the page. A run is 2 warm-up loads plus, per path,
`rounds` x 2 loads, plus 3 loads per path when `prod-url` is set. On the demo site (a small static page) 8 rounds on one path
took about 2 minutes including setup; on Usero (pages of about 1 MB) 8 rounds on two paths with prod took 6.5 to 7 minutes.
Add `timeout-minutes` to the job and a `concurrency` group so a new push cancels the old run, as in the Cloudflare recipe.

The action uses the Google Chrome that GitHub's hosted runners already have, so there is no browser download. On a
self-hosted runner or in a container without Chrome, add `browser-actions/setup-chrome@v1` before it and pass its path as
the `CHROME_BIN` environment variable.

## Method

**Each load is cold.** A fresh browser context per load (empty cache, no cookies, no service worker) in one headless Chrome.
The mobile profile is Lighthouse's: Moto G Power viewport, 150 ms latency, 1.6 Mbps down, 750 Kbps up and 4x CPU slowdown,
applied through the Chrome DevTools Protocol. Absolute numbers are not PageSpeed scores (DevTools throttling is gentler per
request than Lighthouse's, and 4x on a shared CI runner is slower than 4x on a laptop). Only sides measured the same way in
the same job are compared, which is what makes the comparison fair.

**Metrics** come from Google's [web-vitals](https://github.com/GoogleChrome/web-vitals) library, injected before any page
script. After the page settles the action fires the page-hidden event, which is how web-vitals finalises LCP, CLS and INP in
a real tab. TBT follows Lighthouse (each long task's time over 50 ms, from FCP to the end of the load), cut off at load plus
settle, so it covers the loading phase only. INP needs a real interaction, so it is only measured with `interact`, never
estimated.

**Interleaved rounds.** One discarded warm-up load per preview wakes cold servers. Then each round loads main and the PR
once, alternating which goes first, so slow drift on the runner lands on both sides equally. Prod, when given, gets 3 loads
spread over the rounds.

**The test.** Per page and metric, the PR is compared with main by a one-sided Mann-Whitney U test in each direction (exact
up to 80 samples, ties included) and a Hodges-Lehmann shift with its confidence interval. A change counts when p < 0.05
**and** the shift clears a floor:

| Metric   | Floor (the larger of)                 | Why                                                                  |
| -------- | ------------------------------------- | -------------------------------------------------------------------- |
| LCP, FCP | 100 ms or 5% of main, from first byte | Below about 100 ms nobody notices.                                   |
| TBT      | 50 ms or 20%                          | Long-task time is the noisiest lab metric; only big shifts are real. |
| INP      | 25 ms or 20%                          | One scripted click per load; small moves are frame timing noise.     |
| CLS      | 0.01                                  | Lab CLS is nearly deterministic, so any visible shift counts.        |
| TTFB     | reference only                        | See below.                                                           |

**Paint is measured from the first byte.** LCP and FCP are tested as each load's value minus its TTFB. Preview servers
switch between fast and slow first bytes for minutes at a time, on their own, and that used to swamp real paint changes. The
table still shows the full medians, and when the PR's server was slower or faster than main's the comment says so in one
line and splits the change into paint time and server time.

**TTFB is shown but never judged.** Two preview deployments differ in first-byte time for reasons unrelated to the code
(placement, cold caches, separate databases): in A/A runs a TTFB verdict fired 63 to 73% of the time. A server-side slowdown
in a PR therefore has to be read from the TTFB row.

**A failed load** (an HTTP error, a timeout) is recorded with its reason and left out of the stats. A metric needs at least 3
good loads per side to be compared.

### Detection power

Measured on GitHub's ubuntu runners against a real app's previews (Usero, pages of about 1 MB with an LCP near 4 s), 24
rounds per page scored in 1000 random subsets of 8 rounds, with known regressions injected:

| What happened                          | Caught, on two pages |
| -------------------------------------- | -------------------- |
| Nothing (A/A): a false verdict         | 0%, 0%               |
| +300 ms LCP                            | 99%, 100%            |
| +500 ms LCP                            | 100%, 100%           |
| +150 ms TBT                            | 97%, 100%            |
| +500 ms server delay, as an LCP change | 0%, 0% (by design)   |

The last row is the price of measuring paint from the first byte: a slower server shows in the TTFB row, not as a verdict.
Smaller pages have smaller floors, so smaller changes can count; the comment states the floor of each run.

## Limits

- This is a lab test on a shared CI machine, not your users. It catches changes a PR makes to how a page loads; it does not
  predict field Core Web Vitals.
- Previews are not production: cold servers, small databases, no CDN warmth. The verdict compares preview with preview to
  keep that fair.
- Pages behind a login are not supported yet. `headers` can pass a static token if your preview accepts one.
- With 8 rounds a change under the floor can slip through, and the comment says so on every clean run. More rounds narrow it
  and cost time.
- Chrome only.

## License

MIT
