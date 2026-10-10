### Lab web vitals: 2 regressions, 2 improvements vs main, 1 page not compared

```diff
- LCP  /      500 ms slower (23%)
- CLS  /       0.079 worse
+ LCP  /docs  302 ms faster (16%)
+ FCP  /docs  302 ms faster (16%)
```

**Incomplete data**

- `/`: prod failed 4 of 6 loads (HTTP 503).
- `/checkout` was not compared: this PR failed 6 of 6 loads (HTTP 500).
- `/checkout`: prod failed 6 of 6 loads (HTTP 404).

<details open>
<summary>All metrics</summary>

**`/`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| LCP | 2.40 s | 2.91 s | **Slower** +500 ms (+23%) | n/a |
| CLS | 0.002 | 0.081 | **Worse** +0.079 | n/a |
| FCP | 2.39 s | 2.39 s | −3 ms (0%) | n/a |
| TBT | 43 ms | 42 ms | −1 ms (−2%) | n/a |
| TTFB | 200 ms | 199 ms | −1 ms (0%) | n/a |

**`/docs`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| LCP | 2.01 s | 1.71 s | **Faster** −302 ms (−16%) | 1.40 s |
| FCP | 2.01 s | 1.71 s | **Faster** −302 ms (−16%) | 1.40 s |
| CLS | 0.000 | 0.000 | 0.000 | 0.000 |
| TBT | 22 ms | 24 ms | +2 ms (+9%) | 21 ms |
| TTFB | 178 ms | 180 ms | +2 ms (+1%) | 61 ms |

For LCP and FCP, Change is the time after the first byte, so server speed can neither hide nor fake a change. main and this PR show the full medians.

TTFB is for reference and never affects the result. Each preview's server speed varies on its own, so a gap there is usually not this PR.

prod is for reference and never affects the result. It can load third-party tags, data and caches the previews do not, so a gap there is usually not this PR.

</details>

<sub>Report only, never fails the build. Medians of 6 cold mobile loads per side, interleaved, at 150 ms RTT, 1.6 Mbps down and 4x CPU. A change counts when it is significant (one-sided Mann-Whitney, p < 0.05) and larger than a per-metric floor. [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`. By [Usero PR checks](https://github.com/usero-feedback/pr-checks).</sub>
