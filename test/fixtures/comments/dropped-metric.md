### Lab web vitals: no significant change vs main

Nothing on `/` and `/docs` moved past run-to-run noise. With 8 loads per side, smaller shifts can slip through, such as an LCP change under 100 ms.

**Incomplete data**

- LCP on `/` was left out: only 2 of 8 loads on this PR reported it, 3 needed.

<details>
<summary>All metrics, significant changes in bold</summary>

**`/`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| FCP | 1.80 s | 1.82 s | +16 ms (+1%) | 1.81 s |
| CLS | 0.002 | 0.002 | 0.000 | 0.002 |
| TBT | 281 ms | 284 ms | +3 ms (+1%) | 744 ms |
| TTFB | 196 ms | 197 ms | +2 ms (+1%) | 131 ms |

**`/docs`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| LCP | 2.02 s | 2.04 s | +18 ms (+1%) | 2.02 s |
| FCP | 1.70 s | 1.72 s | +15 ms (+1%) | 1.71 s |
| CLS | 0.000 | 0.000 | 0.000 | 0.000 |
| TBT | 0 ms | 0 ms | 0 ms | 523 ms |
| TTFB | 180 ms | 182 ms | +2 ms (+1%) | 129 ms |

For LCP and FCP, Change is the time after the first byte, so server speed can neither hide nor fake a change. main and this PR show the full medians.

TTFB is for reference and never affects the result. Each preview's server speed varies on its own, so a gap there is usually not this PR.

prod is for reference and never affects the result. It can load third-party tags, data and caches the previews do not, so a gap there is usually not this PR.

</details>

<sub>Report only, never fails the build. Medians of 8 cold mobile loads per side (3 on prod), interleaved, at 150 ms RTT, 1.6 Mbps down and 4x CPU. A change counts when it is significant (one-sided Mann-Whitney, p < 0.05) and larger than a per-metric floor. [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`. By [Usero PR checks](https://github.com/usero-feedback/pr-checks).</sub>
