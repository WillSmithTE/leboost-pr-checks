### Lab web vitals: 2 regressions, 1 improvement vs main, 1 page not compared

```diff
- LCP  /      500 ms slower (23%)
- CLS  /       0.079 worse
+ LCP  /docs  302 ms faster (16%)
```

**Incomplete data**

- `/checkout` was not compared: this PR failed 6 of 6 loads (HTTP 500).

<details open>
<summary>All metrics, 6 mobile loads per side</summary>

**`/`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 2.40 s | 2.91 s | **Slower** +500 ms (+23%) |
| CLS | 0.002 | 0.081 | **Worse** +0.079 |
| FCP | 2.39 s | 2.39 s | −3 ms |
| TBT | 43 ms | 42 ms | −1 ms |

**`/docs`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 2.01 s | 1.71 s | **Faster** −302 ms (−16%) |
| TBT | 22 ms | 24 ms | +2 ms |

<sub>prod for reference: LCP 1.40 s, TBT 21 ms</sub>

- `/`: prod failed 4 of 6 loads (HTTP 503).
- `/checkout`: prod failed 6 of 6 loads (HTTP 404).

</details>

<sub>Report only. [How this is measured](https://github.com/usero-feedback/pr-checks#method). [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`.</sub>
