### Lab web vitals: 1 regression vs main

```diff
- TBT  /docs  81 ms slower
```

<details open>
<summary>All metrics</summary>

**`/docs`**

| Metric | main | this PR | Change |
|---|---|---|---|
| TBT | 0 ms | 81 ms | **Slower** +81 ms |
| LCP | 2.02 s | 2.04 s | +18 ms (+1%) |
| FCP | 1.70 s | 1.72 s | +15 ms (+1%) |
| CLS | 0.000 | 0.000 | 0.000 |
| TTFB | 180 ms | 182 ms | +2 ms (+1%) |

**`/`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 2.41 s | 2.43 s | +22 ms (+1%) |
| FCP | 1.80 s | 1.82 s | +16 ms (+1%) |
| CLS | 0.002 | 0.002 | 0.000 |
| TBT | 281 ms | 284 ms | +3 ms (+1%) |
| TTFB | 196 ms | 197 ms | +2 ms (+1%) |

For LCP and FCP, Change is the time after the first byte, so server speed can neither hide nor fake a change. main and this PR show the full medians.

TTFB is for reference and never affects the result. Each preview's server speed varies on its own, so a gap there is usually not this PR.

</details>

<sub>Report only, never fails the build. Medians of 8 cold mobile loads per side, interleaved, at 150 ms RTT, 1.6 Mbps down and 4x CPU. A change counts when it is significant (one-sided Mann-Whitney, p < 0.05) and larger than a per-metric floor. [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`. By [Usero PR checks](https://github.com/usero-feedback/pr-checks).</sub>
