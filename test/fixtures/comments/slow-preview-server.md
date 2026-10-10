### Lab web vitals: no significant change vs main

This PR's preview server responded 314 ms slower than main's on `/`. That is usually not the code, so it is left out of the result.

Nothing on `/` and `/docs` moved past run-to-run noise. With 8 loads per side, smaller shifts can slip through, such as an LCP change under 200 ms.

<details>
<summary>All metrics</summary>

**`/`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| LCP | 5.14 s | 5.46 s | +10 ms (0%)<br><sub>plus 314 ms server time</sub> | 4.05 s |
| FCP | 3.40 s | 3.72 s | +10 ms (0%)<br><sub>plus 314 ms server time</sub> | 2.26 s |
| CLS | 0.002 | 0.002 | 0.000 | 0.002 |
| TBT | 445 ms | 459 ms | +14 ms (+3%) | 790 ms |
| TTFB | 1.19 s | 1.50 s | +314 ms (+26%) | 210 ms |

**`/docs`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| LCP | 2.77 s | 2.78 s | +5 ms (0%) | 2.69 s |
| FCP | 2.27 s | 2.27 s | −2 ms (0%) | 2.19 s |
| CLS | 0.000 | 0.000 | 0.000 | 0.000 |
| TBT | 120 ms | 118 ms | −2 ms (−2%) | 410 ms |
| TTFB | 170 ms | 168 ms | −2 ms (−1%) | 140 ms |

For LCP and FCP, Change is the time after the first byte, so server speed can neither hide nor fake a change. main and this PR show the full medians.

TTFB is for reference and never affects the result. Each preview's server speed varies on its own, so a gap there is usually not this PR.

prod is for reference and never affects the result. It can load third-party tags, data and caches the previews do not, so a gap there is usually not this PR.

</details>

<sub>Report only, never fails the build. Medians of 8 cold mobile loads per side (3 on prod), interleaved, at 150 ms RTT, 1.6 Mbps down and 4x CPU. A change counts when it is significant (one-sided Mann-Whitney, p < 0.05) and larger than a per-metric floor. [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`. By [Usero PR checks](https://github.com/usero-feedback/pr-checks).</sub>
