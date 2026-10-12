### Lab web vitals: no significant change vs main

Nothing on `/` and `/docs` moved past run-to-run noise. With 8 loads per side, smaller shifts can slip through, such as an LCP change under 110 ms.

<details>
<summary>All metrics</summary>

<img src="https://usero.io/pr-checks/chart.png?v=1&amp;m=LCP&amp;p=%2F&amp;s=248.243.250.238.245.241._.247.237.243.249.242.236.244.241.245.238.243.242.241&amp;c=243" width="520" alt="LCP on /, main's last 20 runs ranged 2.36 s to 2.50 s, latest 2.41 s. This PR: 2.43 s.">

**`/`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| LCP | 2.41 s | 2.43 s | +22 ms (+1%) | 2.41 s |
| FCP | 1.80 s | 1.82 s | +16 ms (+1%) | 1.81 s |
| CLS | 0.002 | 0.002 | 0.000 | 0.002 |
| TBT | 281 ms | 284 ms | +3 ms (+1%) | 744 ms |
| Server | 120 ms | 120 ms | 0 ms<br><sub>db 12 ms to 12 ms, 3 to 3 queries</sub> | n/a |

**`/docs`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| LCP | 2.02 s | 2.04 s | +18 ms (+1%) | 2.02 s |
| FCP | 1.70 s | 1.72 s | +15 ms (+1%) | 1.71 s |
| CLS | 0.000 | 0.000 | 0.000 | 0.000 |
| TBT | 0 ms | 0 ms | 0 ms | 523 ms |
| Server | 60 ms | 60 ms | 0 ms | n/a |

For LCP and FCP, Change is the time after the first byte, so server speed can neither hide nor fake a change. main and this PR show the full medians.

prod is for reference and never affects the result. It can load third-party tags, data and caches the previews do not, so a gap there is usually not this PR.

</details>

<sub>Report only, never fails the build. Medians of 8 cold mobile loads per side (3 on prod), interleaved, at 150 ms RTT, 1.6 Mbps down and 4x CPU. Server time from 30 warm requests per side, unthrottled, after 10 on new connections to catch cold starts. A change counts when it is significant (one-sided Mann-Whitney, p < 0.05) and larger than a per-metric floor. [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`. By [Usero PR checks](https://github.com/usero-feedback/pr-checks).</sub>
