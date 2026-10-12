### Lab web vitals: no significant change vs main

**Incomplete data**

- LCP on `/` was left out: only 2 of 8 loads on this PR reported it, 3 needed.

<details>
<summary>All metrics, 8 mobile loads per side</summary>

**`/`**

| Metric | main | this PR | Change |
|---|---|---|---|
| FCP | 1.80 s | 1.82 s | +16 ms |
| CLS | 0.002 | 0.002 | 0.000 |
| TBT | 281 ms | 284 ms | +3 ms |
| Server | 120 ms | 120 ms | 0 ms |

<sub>prod for reference: FCP 1.81 s, CLS 0.002, TBT 744 ms</sub>

**`/docs`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 2.02 s | 2.04 s | +18 ms |
| FCP | 1.70 s | 1.72 s | +15 ms |
| Server | 60 ms | 60 ms | 0 ms |

<sub>prod for reference: LCP 2.02 s, FCP 1.71 s</sub>

</details>

<sub>Report only. [How this is measured](https://github.com/usero-feedback/pr-checks#method). [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`.</sub>
