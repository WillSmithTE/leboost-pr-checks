### Lab web vitals: could not compare with main

**Incomplete data**

- `/` was not compared: this PR failed 8 of 8 loads (HTTP 500).
- Server time on `/` was not compared: this PR failed 30 of 30 requests (HTTP 500).
- `/docs` was not compared: this PR failed 8 of 8 loads (HTTP 500).
- Server time on `/docs` was not compared: this PR failed 30 of 30 requests (HTTP 500).

<sub>Report only, never fails the build. Medians of 8 cold mobile loads per side, interleaved, at 150 ms RTT, 1.6 Mbps down and 4x CPU. Server time from 30 warm requests per side, unthrottled, after 10 on new connections to catch cold starts. A change counts when it is significant (one-sided Mann-Whitney, p < 0.05) and larger than a per-metric floor. [CI run](https://github.com/acme/shop/actions/runs/123456) for `9f8e7d6`. By [Usero PR checks](https://github.com/usero-feedback/pr-checks).</sub>
