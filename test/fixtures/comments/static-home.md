### Lab web vitals: 2 improvements vs main

```diff
+ LCP     /  962 ms faster (24%)
+ Server  /   37 ms faster
```

<details open>
<summary>All metrics, 8 mobile loads per side</summary>

**`/`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 4.01 s | 3.05 s | **Faster** −962 ms (−24%) |
| Server | 61 ms | 24 ms (static) | **Faster** −37 ms |
| CLS | 0.002 | 0.002 | 0.000 |
| TBT | 289 ms | 284 ms | −5 ms |

<sub>Page is static on this PR, not on main, so LCP is judged with the first byte (1.14 s to 104 ms)<br>Cold starts 1.33 s to none (9 and 0 of 45), not judged</sub>

**`/docs`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 3.45 s | 3.95 s | +498 ms |
| TBT | 474 ms | 576 ms | +102 ms |
| Server | 57 ms | 64 ms | +7 ms |

<sub>LCP +498 ms: +479 ms first byte, +19 ms after it. Only the time after the first byte is judged. Server time itself: +7 ms<br>Cold starts 1.19 s to 1.27 s (3 and 8 of 45), not judged</sub>

</details>

<sub>Report only. [How this is measured](https://github.com/usero-feedback/pr-checks#method). [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`.</sub>
