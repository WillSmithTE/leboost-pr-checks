### Lab web vitals: 1 regression vs main

```diff
- LCP  /  579 ms slower (26%)
```

<img src="https://usero.io/pr-checks/chart.png?v=1&amp;m=LCP&amp;p=%2F&amp;s=248.243.250.238.245.241._.247.237.243.249.242.236.244.241.245.238.243.242.241&amp;c=299" width="520" alt="LCP on /, main's last 20 runs ranged 2.36 s to 2.50 s, latest 2.41 s. This PR: 2.99 s.">

<details open>
<summary>All metrics</summary>

**`/`**

| Metric | main | this PR | Change | prod |
|---|---|---|---|---|
| LCP | 2.41 s | 2.99 s | **Slower** +579 ms (+26%) | 2.41 s |
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
