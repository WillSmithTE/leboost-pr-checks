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

<img src="https://usero.io/pr-checks/chart.png?v=1&amp;m=LCP&amp;p=%2F&amp;s=248.243.250.238.245.241._.247.237.243.249.242.236.244.241.245.238.243.242.241&amp;c=291" width="520" alt="LCP on /, main's last 20 runs ranged 2.36 s to 2.50 s, latest 2.41 s. This PR: 2.91 s.">

<img src="https://usero.io/pr-checks/chart.png?v=1&amp;m=LCP&amp;p=%2Fdocs&amp;s=207.203.209.199.205.201._.206.198.203.208.202.197.204.201.205.199.203.202.201&amp;c=171" width="520" alt="LCP on /docs, main's last 20 runs ranged 1.97 s to 2.09 s, latest 2.01 s. This PR: 1.71 s.">

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
