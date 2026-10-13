### Lab web vitals: no significant change vs main

<details>
<summary>All metrics, 8 mobile loads per side</summary>

**`/`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 5.14 s | 5.46 s | +322 ms |
| FCP | 3.40 s | 3.72 s | +322 ms |
| CLS | 0.002 | 0.002 | 0.000 |
| TBT | 445 ms | 459 ms | +14 ms |
| Server | 150 ms | 150 ms | 0 ms |

<sub>Judged after the first byte: LCP +10 ms, FCP +10 ms. First byte +312 ms left out, server time 0 ms<br>prod for reference: LCP 4.05 s, FCP 2.26 s, CLS 0.002, TBT 790 ms</sub>

**`/docs`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 2.77 s | 2.78 s | +5 ms |
| FCP | 2.27 s | 2.27 s | −2 ms |
| TBT | 120 ms | 118 ms | −2 ms |
| Server | 150 ms | 150 ms | 0 ms |

<sub>prod for reference: LCP 2.69 s, FCP 2.19 s, TBT 410 ms</sub>

</details>

<sub>Report only. [How this is measured](https://github.com/usero-feedback/pr-checks#method). [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`.</sub>
