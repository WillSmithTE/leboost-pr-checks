### Lab web vitals: 1 regression vs main

```diff
- Server  /  300 ms slower (300%)
```

<details open>
<summary>All metrics</summary>

**`/`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| Server | 100 ms | 400 ms | **Slower** +300 ms (+300%)<br><sub>db 12 ms to 312 ms, 3 to 4 queries, 2 cold requests left out</sub> | n/a |
| LCP | 2.41 s | 2.43 s | +22 ms (+1%) | 2.41 s |
| FCP | 1.80 s | 1.82 s | +16 ms (+1%) | 1.81 s |
| CLS | 0.002 | 0.002 | 0.000 | 0.002 |
| TBT | 281 ms | 284 ms | +3 ms (+1%) | 744 ms |

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

<sub>Report only, never fails the build. Medians of 8 cold mobile loads per side (3 on prod), interleaved, at 150 ms RTT, 1.6 Mbps down and 4x CPU. Server time from 30 warm requests per side, unthrottled. A change counts when it is significant (one-sided Mann-Whitney, p < 0.05) and larger than a per-metric floor. [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`. By [Usero PR checks](https://github.com/usero-feedback/pr-checks).</sub>
