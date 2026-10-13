### Lab web vitals: 1 regression vs main

```diff
- LCP  /  579 ms slower (26%)
```

<sub>main is 6 commits past this PR's base, and its preview may already run them, so a change above can be theirs. Merge main and push to compare like for like.</sub>

<details open>
<summary>All metrics, 8 mobile loads per side</summary>

**`/`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 2.41 s | 2.99 s | **Slower** +579 ms (+26%) |
| FCP | 1.80 s | 1.82 s | +16 ms |
| CLS | 0.002 | 0.002 | 0.000 |
| TBT | 281 ms | 284 ms | +3 ms |
| Server | 120 ms | 120 ms | 0 ms |

<sub>prod for reference: LCP 2.41 s, FCP 1.81 s, CLS 0.002, TBT 744 ms</sub>

**`/docs`**

| Metric | main | this PR | Change |
|---|---|---|---|
| LCP | 2.02 s | 2.04 s | +18 ms |
| FCP | 1.70 s | 1.72 s | +15 ms |
| Server | 60 ms | 60 ms | 0 ms |

<sub>prod for reference: LCP 2.02 s, FCP 1.71 s</sub>

<sub>Newest on main since this PR's base: "Hero image as AVIF", "Blog index from the loader", "Docs: QA shots".</sub>

</details>

<sub>Report only. [How this is measured](https://github.com/usero-feedback/pr-checks#method). [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`.</sub>
