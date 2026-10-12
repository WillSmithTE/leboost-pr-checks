### Lab web vitals: no significant change vs main

Nothing on `/` and `/docs` moved past run-to-run noise. With 8 loads per side, smaller shifts can slip through, such as an LCP change under 200 ms.

<details>
<summary>All metrics</summary>

**`/`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| LCP | 5.14 s | 5.46 s | +10 ms (0%) | 4.05 s |
| FCP | 3.40 s | 3.72 s | +10 ms (0%) | 2.26 s |
| CLS | 0.002 | 0.002 | 0.000 | 0.002 |
| TBT | 445 ms | 459 ms | +14 ms (+3%) | 790 ms |
| Server | 150 ms | 150 ms | 0 ms | n/a |

**`/docs`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| LCP | 2.77 s | 2.78 s | +5 ms (0%) | 2.69 s |
| FCP | 2.27 s | 2.27 s | −2 ms (0%) | 2.19 s |
| CLS | 0.000 | 0.000 | 0.000 | 0.000 |
| TBT | 120 ms | 118 ms | −2 ms (−2%) | 410 ms |
| Server | 150 ms | 150 ms | 0 ms | n/a |

For LCP and FCP, Change is the time after the first byte, so server speed can neither hide nor fake a change. main and this PR show the full medians.

prod is for reference and never affects the result. It can load third-party tags, data and caches the previews do not, so a gap there is usually not this PR.

</details>

<sub>Report only, never fails the build. Medians of 8 cold mobile loads per side (3 on prod), interleaved, at 150 ms RTT, 1.6 Mbps down and 4x CPU. Server time from 30 warm requests per side, unthrottled, after 10 on new connections to catch cold starts. A change counts when it is significant (one-sided Mann-Whitney, p < 0.05) and larger than a per-metric floor. [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`. By [Usero PR checks](https://github.com/usero-feedback/pr-checks).</sub>
