### Lab web vitals: 1 regression vs main

```diff
- LCP  /  962 ms slower (32%)
```

<details open>
<summary>All metrics, 8 mobile loads per side</summary>

**`/`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 3.05 s | 4.01 s | **Slower** +962 ms (+32%) |
| CLS | 0.002 | 0.002 | 0.000 |
| TBT | 284 ms | 289 ms | +5 ms |
| Server | 24 ms (static) | 61 ms | not judged |

<sub>Server no longer static, so LCP counts the first byte (104 ms to 1.14 s)<br>Cold starts none to 1.33 s (0 and 9 of 45), not judged</sub>

**`/docs`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 3.95 s | 3.45 s | −498 ms |
| TBT | 576 ms | 474 ms | −102 ms |
| Server | 64 ms | 57 ms | −7 ms |

<sub>Judged after the first byte: LCP −19 ms. First byte −479 ms left out, server time −7 ms<br>Cold starts 1.27 s to 1.19 s (8 and 3 of 45), not judged</sub>

</details>

<sub>Report only. [How this is measured](https://github.com/usero-feedback/pr-checks#method). [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`.</sub>
