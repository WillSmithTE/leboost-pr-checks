### Lab web vitals: 1 improvement vs main

```diff
+ Server  /docs  115 ms faster (82%)
```

<details open>
<summary>All metrics, 8 mobile loads per side</summary>

**`/docs`**

| Metric | main | this PR | Change |
|---|---|---|---|
| Server | 140 ms | 25 ms (static) | **Faster** −115 ms (−82%) |
| LCP | 2.02 s | 2.04 s | +20 ms |
| FCP | 1.70 s | 1.72 s | +17 ms |

<sub>Page is static on this PR, not on main, so LCP and FCP are judged with the first byte (180 ms to 182 ms)<br>prod for reference: LCP 2.02 s, FCP 1.71 s</sub>

**`/`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 2.41 s | 2.43 s | +22 ms |
| FCP | 1.80 s | 1.82 s | +16 ms |
| CLS | 0.002 | 0.002 | 0.000 |
| TBT | 281 ms | 284 ms | +3 ms |
| Server | 120 ms | 120 ms | 0 ms |

<sub>prod for reference: LCP 2.41 s, FCP 1.81 s, CLS 0.002, TBT 744 ms</sub>

</details>

<sub>Report only. [How this is measured](https://github.com/usero-feedback/pr-checks#method). [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`.</sub>
