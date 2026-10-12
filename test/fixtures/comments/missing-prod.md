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
| Server | 60 ms | 60 ms | 0 ms |

**`/`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 2.41 s | 2.43 s | +22 ms (+1%) |
| FCP | 1.80 s | 1.82 s | +16 ms (+1%) |
| CLS | 0.002 | 0.002 | 0.000 |
| TBT | 281 ms | 284 ms | +3 ms (+1%) |
| Server | 120 ms | 120 ms | 0 ms<br><sub>db 12 ms to 12 ms, 3 to 3 queries</sub> |

For LCP and FCP, Change is the time after the first byte, so server speed can neither hide nor fake a change. main and this PR show the full medians.

</details>

<sub>Report only, never fails the build. Medians of 8 cold mobile loads per side, interleaved, at 150 ms RTT, 1.6 Mbps down and 4x CPU. Server time from 30 warm requests per side, unthrottled, after 10 on new connections to catch cold starts. A change counts when it is significant (one-sided Mann-Whitney, p < 0.05) and larger than a per-metric floor. [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`. By [Usero PR checks](https://github.com/usero-feedback/pr-checks).</sub>
