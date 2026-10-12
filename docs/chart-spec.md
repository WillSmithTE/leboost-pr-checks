# Trend chart spec

The PR comment can carry one small PNG per changed page: main's recent history for the metric that changed, with this PR's
value set apart on the right. usero.io draws it statelessly from the query string. No storage, no account.

| Situation                         | Reference                                               |
| --------------------------------- | ------------------------------------------------------- |
| Slower, one missing run           | [slower-lcp.svg](chart/slower-lcp.svg) ([png](chart/slower-lcp.png)) |
| Faster, main drifting up          | [faster-lcp.svg](chart/faster-lcp.svg) ([png](chart/faster-lcp.png)) |
| No change, two missing runs       | [no-change-lcp.svg](chart/no-change-lcp.svg) ([png](chart/no-change-lcp.png)) |
| TBT, 4 runs, long page truncated  | [tbt-short-history.svg](chart/tbt-short-history.svg) ([png](chart/tbt-short-history.png)) |
| CLS score                         | [cls-worse.svg](chart/cls-worse.svg) ([png](chart/cls-worse.png)) |

The reference renderer is [chart/chart-svg.ts](chart/chart-svg.ts): `parseChartQuery()` then `renderChartSvg()`. It is
plain TypeScript with no dependencies, typechecked and tested in this repo (`test/chart-svg.test.ts`), so the Worker can lift
it as is and add only the rasteriser.

## What it shows, and why

- **One metric, one page, one chart.** The metric is the one the comment flagged (LCP, FCP, CLS, TBT, Server or INP), not a fixed
  LCP. Two metrics on one axis would need a legend and a second scale; on a phone that is unreadable.
- **main's line, oldest to newest:** main's median per past run, the last 20 (30 at most). A run with no value is a gap
  bridged by a faint dotted line, so it reads as missing data rather than a glitch.
- **This PR as one orange dot** in its own tinted column to the right, joined to main's latest point by a dashed orange
  line. The step from the line to the dot is the whole story; the y labels give the scale.
- **Where the comment puts it:** first inside the fold (open whenever something changed), one chart per page with a
  significant change (its first flagged metric, regressions first), three at most. A quiet run has no chart: there is no
  step to show, and a notification email shows the fold's content anyway.
- **No health bands.** Google's good / needs improvement / poor thresholds (LCP 2.5 s and 4 s) are defined on real-user p75
  field data. This is a median of throttled lab loads on Slow 4G with a 4x slower CPU, which runs well above typical field
  values. A band would call most pages "poor" for reasons unrelated to the PR and pull the eye from the one question the chart
  answers: is this PR out of line with main? Leave them out of the chart and the comment.

## Query format (v1)

```
https://usero.io/pr-checks/chart.png?v=1&m=LCP&p=%2Fpricing&s=241.238._.246.240.240&c=299
```

| Param | Meaning                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| `v`   | Format version, `1`. Anything else is a 400; a new format gets a new number and both are served.                  |
| `m`   | Metric: `LCP`, `FCP`, `CLS`, `TBT`, `TTFB`, `Server` or `INP`.                                                    |
| `p`   | Page path, URI-encoded, at most 60 characters (longer ones end in `...`). The chart title shows 30.               |
| `s`   | main's history, oldest first, `.`-separated. Timings in tens of ms, CLS in thousandths, integers 0 to 99999. `_` is a run with no value. 3 to 30 points, at least 3 of them numbers. |
| `c`   | Optional. This PR's median, same units. Without it there is no orange dot or column.                              |

Values are rounded to 10 ms, invisible at this size, so 20 runs cost about 80 characters. The longest legal URL (30 points of
99999 and a 60-character page of multi-byte characters) is about 600 characters. The Action's `chartUrl()` (`src/chart.ts`)
also drops the oldest points if a custom base URL would push the total past 1500 characters, and returns null under 3 points,
in which case the comment has no image.

The Action builds the alt text itself from the same data, for blocked images and screen readers:
`LCP on /pricing, main's last 20 runs ranged 2.38 s to 2.46 s, latest 2.40 s. This PR: 2.99 s.`

## Visual spec

All sizes are CSS px in a 520 x 240 viewBox. The PNG is rendered at 2x (1040 x 480) and the comment sets `width="520"`, so it
is sharp on a phone and never wider than a Gmail column. On a 390 px phone it displays at about 345 px, so the smallest text
(15 px) lands near 10 px.

**Colour.** Usero's email palette, so the chart and the emails read as one product. One accent, orange, used only for this
PR. The card is white: GitHub light shows it as a bordered card, GitHub dark as a bright card like any embedded screenshot,
and email clients do not invert images. A mid-grey that tried to suit both themes looked muddy in both.

| Token    | Hex       | Use                                              |
| -------- | --------- | ------------------------------------------------ |
| `card`   | `#FFFFFF` | Card fill; halo behind main's value label        |
| `border` | `#E4E6E3` | Card stroke 1.5, radius 12; corners transparent  |
| `ink`    | `#0D2433` | Title, main's line and dot, value labels         |
| `muted`  | `#5F6D78` | Tick labels, "main, last N runs" (5.3:1 on white) |
| `grid`   | `#E4E6E3` | Horizontal gridlines, 1 px                       |
| `gap`    | `#B4BCC2` | Dotted bridge over missing runs                  |
| `accent` | `#FF5A1F` | This PR's dot and dashed connector               |
| `band`   | `#FFF1EB` | This PR's column; halo behind its value label    |

**Type.** Atkinson Hyperlegible (Braille Institute, SIL OFL), Regular 400 and Bold 700, chosen for digits that cannot be
confused at 10 px (open 3/8, distinct 0). Bundle the two TTFs in the Worker, subset to Basic Latin (U+0020 to U+007E, about
20 KB each with `pyftsubset --unicodes=U+0020-007E`), and pass them to resvg as `fontBuffers` with `loadSystemFonts: false`
and `defaultFontFamily: 'Atkinson Hyperlegible'`. Source: `github.com/google/fonts/tree/main/ofl/atkinsonhyperlegible`.
Text never uses `dominant-baseline` (resvg support is partial); baselines are explicit.

| Text                     | Position                         | Size, weight, colour       |
| ------------------------ | -------------------------------- | -------------------------- |
| "LCP on /pricing"        | x 20, baseline 38                | 20, 700, ink               |
| Tick labels              | right-aligned at x 74, tick y + 5 | 15, 400, muted             |
| main's latest value      | centred on its point, 14 above or 26 below | 17, 400, ink, 4 px card halo |
| This PR's value          | centred on the dot, opposite side to main's label | 17, 700, ink, 4 px band halo |
| "main, last 20 runs"     | x 90, baseline 222               | 15, 400, muted             |
| "this PR"                | centred x 462, baseline 222      | 15, 700, ink               |

The PR label goes above its dot when the PR is at or above main's latest value, main's label below its point, and the other
way round when the PR is lower, so the two never stack. Values use the comment's format: `2.41 s` from 1000 ms, `850 ms`
below, CLS to three decimals.

**Geometry.**

- Plot area y 70 (top) to 172 (bottom). Gridlines from x 82 to 500. The widest tick label (`800 ms`, about 53 px) then
  starts near x 21, in line with the title, instead of touching the card's edge.
- main's points evenly spaced from x 90 to 400; line 2.25 px, round joins and caps; latest point a dot r 4.
- This PR at x 462: column 60 wide, from y 56 to 230, radius 8, `band` fill. Dot r 7, `accent` fill, 2.5 px white stroke.
  Connector from main's latest point, 1.5 px, dash 3 4.

**Y scale.** Domain covers main's values and this PR's. Its span is at least the larger of a per-metric minimum (LCP and FCP
200 ms, TTFB, Server and TBT 100 ms, INP 50 ms, CLS 0.05) and 20% of main's median, so run-to-run noise draws as a wobble instead of a
cliff; then 12% padding each side, floored at 0. Gridlines at the nice step (1, 2, 2.5 or 5 x 10^n) that gives three lines,
else two, else four, never one or five (the larger step on a tie). Dividing the range by three and rounding up, as v1 first
did, could leave a single line.
Tick labels in seconds once any tick reaches 1000 ms, with as many decimals as the step needs (`2.5 s`, `2.25 s`).

## Serving

- `GET /pr-checks/chart.png` with the v1 query: 200 `image/png`, or 400 with a one-line plain-text reason from
  `parseChartQuery()`.
- `Cache-Control: public, max-age=31536000, immutable`: the image is a pure function of the URL. GitHub's camo proxy and
  Gmail's image proxy fetch it once and keep it.
- Keep the Worker cheap: cache the PNG at the edge by full URL, and reject queries over 2048 characters before parsing.
