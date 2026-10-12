### Lab web vitals: 1 regression vs main

```diff
- TBT  /docs  81 ms slower
```

<details open>
<summary>All metrics, 8 mobile loads per side</summary>

**`/docs`**

| Metric | main | this PR | Change |
|---|---|---|---|
| TBT | 0 ms | 81 ms | **Slower** +81 ms |
| LCP | 2.02 s | 2.04 s | +18 ms |
| FCP | 1.70 s | 1.72 s | +15 ms |
| Server | 60 ms | 60 ms | 0 ms |

**`/`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 2.41 s | 2.43 s | +22 ms |
| FCP | 1.80 s | 1.82 s | +16 ms |
| CLS | 0.002 | 0.002 | 0.000 |
| TBT | 281 ms | 284 ms | +3 ms |
| Server | 120 ms | 120 ms | 0 ms |

</details>

<sub>Report only. [How this is measured](https://github.com/usero-feedback/pr-checks#method). [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`.</sub>
